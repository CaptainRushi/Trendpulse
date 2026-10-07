/**
 * SheetsRepo — all content reads/writes against Google Sheets.
 * Append-only for raw/sorted/digest/runs_log; the ONLY update the app ever
 * performs is flipping stale is_latest flags (markLatest), addressed by
 * scanning run_date + is_latest columns — never by remembered row numbers,
 * so human row edits elsewhere can't corrupt it.
 */
import { SheetsCache } from "./cache.js";
import { isMissingRangeError } from "./client.js";
import type { SheetsClient } from "./client.js";
import {
  digestRecordToRow,
  rawRecordToRow,
  rowToDigestRecord,
  rowToRawRecord,
  rowToRunLogRecord,
  rowToSortedRecord,
  runLogRecordToRow,
  sortedRecordToRow,
  RowParseError,
} from "./mappers.js";
import { shiftDate } from "../utils/time.js";
import { SheetsWriteQueue } from "./queue.js";
import {
  DAILY_DIGEST_TAB,
  MAX_APPEND_BATCH,
  RAW_TRENDS_HEADERS,
  RAW_TRENDS_TAB,
  REQUIRED_TABS,
  RUNS_LOG_TAB,
  SORTED_TRENDS_TAB,
  TAB_HEADERS,
} from "./schema.js";
import type {
  DigestRecord,
  RawTrendRecord,
  RunLogRecord,
  SortedTrendRecord,
} from "./schema.js";

export interface RepoOptions {
  spreadsheetId: string;
  cacheTtlS?: number;
  queue?: SheetsWriteQueue;
}

export interface AppendResult {
  rowsAppended: number;
  batches: number;
}

export interface ReadResult<T> {
  rows: T[];
  warnings: number;
  /** Seconds since the underlying sheet read (0 = just fetched). */
  ageS: number;
}

export interface RetainOptions {
  runDate: string;
  retentionDays: number;
  retentionMode: "archive" | "delete";
}

export interface RetainResult {
  archived: number;
  deleted: number;
  warnings: number;
  tabs: string[];
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export class SheetsRepo {
  private readonly client: SheetsClient;
  private readonly spreadsheetId: string;
  private readonly cache: SheetsCache;
  private readonly queue: SheetsWriteQueue;

  constructor(client: SheetsClient, options: RepoOptions) {
    this.client = client;
    this.spreadsheetId = options.spreadsheetId;
    this.cache = new SheetsCache(options.cacheTtlS ?? 60);
    this.queue = options.queue ?? new SheetsWriteQueue();
  }

  /** Clear the read cache (Sync button, post-run). */
  sync(): Promise<void> {
    this.cache.invalidate();
    return Promise.resolve();
  }

  /** Liveness check for /api/health: lists tabs without mutating anything. */
  async ping(): Promise<string[]> {
    return this.client.getTabTitles(this.spreadsheetId);
  }

  /**
   * Create missing tabs + header rows. Idempotent: existing non-empty headers
   * are never overwritten (a human may have annotated them). Short headers
   * that match the registry prefix gain only the missing trailing cells
   * (CATRUN-10: sheet upgrades itself when the registry grows).
   */
  async init(): Promise<{ created: string[]; headersWritten: string[]; upgraded: string[] }> {
    const created: string[] = [];
    const headersWritten: string[] = [];
    const upgraded: string[] = [];
    const titles = await this.client.getTabTitles(this.spreadsheetId);
    for (const tab of REQUIRED_TABS) {
      if (!titles.includes(tab)) {
        await this.client.addTab(this.spreadsheetId, tab);
        created.push(tab);
      }
      const first = await this.client.getFirstRow(this.spreadsheetId, tab);
      const headers = TAB_HEADERS[tab];
      if (headers === undefined) throw new Error(`unknown tab '${tab}' has no header definition`);
      if (first === null || first.length === 0 || first.every((c) => c === "")) {
        await this.client.writeFirstRow(this.spreadsheetId, tab, [...headers]);
        headersWritten.push(tab);
      } else if (first.length < headers.length && headers.slice(0, first.length).every((h, i) => h === first[i])) {
        const missing = headers.slice(first.length);
        const startCol = columnLetter(first.length);
        const endCol = columnLetter(headers.length - 1);
        await this.client.batchUpdate(this.spreadsheetId, [
          { range: `${tab}!${startCol}1:${endCol}1`, values: [missing] },
        ]);
        upgraded.push(tab);
      }
    }
    return { created, headersWritten, upgraded };
  }

  async appendRaw(records: RawTrendRecord[]): Promise<AppendResult> {
    return this.appendBatched(RAW_TRENDS_TAB, records.map(rawRecordToRow));
  }

  async appendSorted(records: SortedTrendRecord[]): Promise<AppendResult> {
    return this.appendBatched(SORTED_TRENDS_TAB, records.map(sortedRecordToRow));
  }

  async appendDigest(record: DigestRecord): Promise<AppendResult> {
    return this.appendBatched(DAILY_DIGEST_TAB, [digestRecordToRow(record)]);
  }

  async appendRunLog(record: RunLogRecord): Promise<AppendResult> {
    return this.appendBatched(RUNS_LOG_TAB, [runLogRecordToRow(record)]);
  }

  private async appendBatched(tab: string, rows: string[][]): Promise<AppendResult> {
    if (rows.length === 0) return { rowsAppended: 0, batches: 0 };
    const batches = chunk(rows, MAX_APPEND_BATCH);
    let n = 0;
    for (const batch of batches) {
      n += 1;
      const label = `append ${tab} batch ${String(n)}/${String(batches.length)}`;
      await this.queue.enqueue(label, () => this.appendWithAutoReinit(tab, batch));
    }
    this.cache.invalidate();
    return { rowsAppended: rows.length, batches: batches.length };
  }

  /** Deleted tab → init once, retry once. Anything else propagates. */
  private async appendWithAutoReinit(tab: string, batch: string[][]): Promise<void> {
    try {
      await this.client.appendRows(this.spreadsheetId, tab, batch);
    } catch (error) {
      if (!isMissingRangeError(error)) throw error;
      await this.init();
      await this.client.appendRows(this.spreadsheetId, tab, batch);
    }
  }

  async readRaw(filter: { runId?: string } = {}): Promise<ReadResult<RawTrendRecord>> {
    // One shared entry holds the unfiltered rows; runId filtering applies
    // on every read (the old per-filter keys each stored a full copy).
    const cached = this.cache.get<{ rows: RawTrendRecord[]; warnings: number }>("raw:all");
    if (cached) {
      const rows =
        filter.runId === undefined
          ? cached.value.rows
          : cached.value.rows.filter((r) => r.run_id === filter.runId);
      return { rows, warnings: cached.value.warnings, ageS: cached.ageS };
    }
    const values = await this.client.getAllValues(this.spreadsheetId, RAW_TRENDS_TAB);
    const result = parseDataRows(values, rowToRawRecord);
    // Cache the unfiltered set; runId filtering applies on every read.
    this.cache.set("raw:all", { rows: result.rows, warnings: result.warnings });
    const rows =
      filter.runId === undefined ? result.rows : result.rows.filter((r) => r.run_id === filter.runId);
    return { rows, warnings: result.warnings, ageS: 0 };
  }

  async readSorted(
    filter: { runDate?: string; onlyLatest?: boolean } = {},
    opts: { includeHidden?: boolean } = {},
  ): Promise<ReadResult<SortedTrendRecord>> {
    const onlyLatest = filter.onlyLatest ?? true;
    const key = `sorted:${filter.runDate ?? ""}:${onlyLatest ? "latest" : "all"}:${opts.includeHidden === true ? "withhidden" : "visible"}`;
    const cached = this.cache.get<{ rows: SortedTrendRecord[]; warnings: number }>(key);
    if (cached) return { rows: cached.value.rows, warnings: cached.value.warnings, ageS: cached.ageS };
    const values = await this.client.getAllValues(this.spreadsheetId, SORTED_TRENDS_TAB);
    const result = parseDataRows(values, rowToSortedRecord);
    const rows = result.rows.filter(
      (r) =>
        (filter.runDate === undefined || r.run_date === filter.runDate) &&
        (!onlyLatest || r.is_latest) &&
        (opts.includeHidden === true || !r.hidden),
    );
    this.cache.set(key, { rows, warnings: result.warnings });
    return { rows, warnings: result.warnings, ageS: 0 };
  }

  /** Latest digest row for the date (append-only → last matching row wins). */
  async readDigest(
    runDate: string,
  ): Promise<{ row: DigestRecord | null; warnings: number; ageS: number }> {
    const key = `digest:${runDate}`;
    const cached = this.cache.get<{ row: DigestRecord | null; warnings: number }>(key);
    if (cached) return { ...cached.value, ageS: cached.ageS };
    const values = await this.client.getAllValues(this.spreadsheetId, DAILY_DIGEST_TAB);
    const result = parseDataRows(values, rowToDigestRecord);
    const matches = result.rows.filter((r) => r.run_date === runDate && r.is_latest);
    const latest = matches.length > 0 ? matches[matches.length - 1] : null;
    const out = { row: latest ?? null, warnings: result.warnings };
    this.cache.set(key, out);
    return { ...out, ageS: 0 };
  }

  /** Full run history, newest last (append-only). Feeds the Runs page. */
  async readRunLog(): Promise<ReadResult<RunLogRecord>> {
    const key = "runs:all";
    const cached = this.cache.get<{ rows: RunLogRecord[]; warnings: number }>(key);
    if (cached) return { rows: cached.value.rows, warnings: cached.value.warnings, ageS: cached.ageS };
    const values = await this.client.getAllValues(this.spreadsheetId, RUNS_LOG_TAB);
    const out = parseDataRows(values, rowToRunLogRecord);
    this.cache.set(key, { rows: out.rows, warnings: out.warnings });
    return { rows: out.rows, warnings: out.warnings, ageS: 0 };
  }

  /**
   * Flip is_latest → FALSE on every other run's rows for the date.
   * The only cell-update the app performs (re-sort flow, TRD §9).
   * Sorted rows flip only within the same match: a Doc-17 scope (until Q3
   * removes it) or a Jev category label (Doc 19: one set per date+category).
   * A category refresh never touches the digest; digest rows carry no
   * category (only full runs flip them).
   */
  async markLatest(
    runDate: string,
    keepRunId: string,
    match: { scope?: string; category?: string } = {},
  ): Promise<{ flipped: number }> {
    let flipped = 0;
    flipped += await this.flipStaleLatest(SORTED_TRENDS_TAB, "run_date", 2, "run_id", 1, "is_latest", 23, runDate, keepRunId, match);
    if (match.category === undefined) {
      flipped += await this.flipStaleLatest(DAILY_DIGEST_TAB, "run_date", 0, "run_id", 1, "is_latest", 10, runDate, keepRunId, match.scope === undefined ? {} : { scope: match.scope });
    }
    this.cache.invalidate();
    return { flipped };
  }

  /** Flip stale digest rows only (full runs); subset refreshes never touch the digest. */
  async markDigestLatest(runDate: string, keepRunId: string): Promise<{ flipped: number }> {
    const flipped = await this.flipStaleLatest(DAILY_DIGEST_TAB, "run_date", 0, "run_id", 1, "is_latest", 10, runDate, keepRunId, {});
    this.cache.invalidate();
    return { flipped };
  }

  /**
   * Retention for raw_trends (TRD §9): rows with collected_at older than
   * runDate − retentionDays move to archive_YYYY_MM tabs (archive mode) or
   * vanish (delete mode). Archive copies land before any deletion, so a
   * failed copy keeps the rows. Rows with undateable collected_at are kept
   * and counted as warnings. Deletions run per maximal aged run in
   * descending order, so sheet indices stay valid.
   */
  async retainRaw(options: RetainOptions): Promise<RetainResult> {
    const empty: RetainResult = { archived: 0, deleted: 0, warnings: 0, tabs: [] };
    let values: string[][];
    try {
      values = await this.client.getAllValues(this.spreadsheetId, RAW_TRENDS_TAB);
    } catch (error) {
      if (!isMissingRangeError(error)) throw error;
      return empty;
    }
    const cutoff = shiftDate(options.runDate, -options.retentionDays);
    const aged: { sheetRow: number; cells: string[] }[] = [];
    let warnings = 0;
    values.forEach((cells, index) => {
      if (index === 0) return; // header
      const day = (cells[2] ?? "").slice(0, 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) {
        warnings += 1;
        return;
      }
      if (day < cutoff) aged.push({ sheetRow: index, cells });
    });
    if (aged.length === 0) return { ...empty, warnings };

    const tabs: string[] = [];
    let archived = 0;
    if (options.retentionMode === "archive") {
      const byMonth = new Map<string, string[][]>();
      for (const row of aged) {
        const month = (row.cells[2] ?? "").slice(0, 7).replace("-", "_");
        const list = byMonth.get(month) ?? [];
        list.push([...row.cells]);
        byMonth.set(month, list);
      }
      const titles = await this.client.getTabTitles(this.spreadsheetId);
      for (const [month, rows] of byMonth) {
        const tab = `archive_${month}`;
        if (!titles.includes(tab)) {
          await this.client.addTab(this.spreadsheetId, tab);
          await this.client.writeFirstRow(this.spreadsheetId, tab, [...RAW_TRENDS_HEADERS]);
          titles.push(tab);
        }
        const result = await this.appendBatched(tab, rows);
        archived += result.rowsAppended;
        tabs.push(tab);
      }
    }

    const runs: [number, number][] = [];
    for (const row of aged) {
      const last = runs[runs.length - 1];
      if (last && row.sheetRow === last[1]) last[1] = row.sheetRow + 1;
      else runs.push([row.sheetRow, row.sheetRow + 1]);
    }
    let deleted = 0;
    for (const [start, end] of [...runs].reverse()) {
      const label = `retain ${RAW_TRENDS_TAB} rows ${String(start)}-${String(end)}`;
      await this.queue.enqueue(label, () =>
        this.client.deleteRows(this.spreadsheetId, RAW_TRENDS_TAB, start, end),
      );
      deleted += end - start;
    }
    this.cache.invalidate();
    return { archived, deleted, warnings, tabs };
  }

  private async flipStaleLatest(    tab: string,
    dateHeader: string,
    dateCol: number,
    idHeader: string,
    idCol: number,
    flagHeader: string,
    flagCol: number,
    runDate: string,
    keepRunId: string,
    match: { scope?: string; category?: string } = {},
  ): Promise<number> {
    const values = await this.client.getAllValues(this.spreadsheetId, tab);
    const header = values[0];
    if (header === undefined) return 0;
    // Verify by header NAME, not assumed position — a human may reorder columns.
    if (header[dateCol] !== dateHeader || header[idCol] !== idHeader || header[flagCol] !== flagHeader) {
      throw new Error(
        `sheets tab '${tab}' has unexpected headers; refusing to flip is_latest (expected ${dateHeader}/${idHeader}/${flagHeader})`,
      );
    }
    // Scope column is trailing and optional: old rows without it read as "all".
    const scopeCol = match.scope === undefined ? -1 : header.indexOf("scope");
    const categoryCol = match.category === undefined ? -1 : header.indexOf("category");
    const flagLetter = columnLetter(flagCol);
    const updates: { range: string; values: string[][] }[] = [];
    values.forEach((row, idx) => {
      if (idx === 0) return;
      if (row[dateCol] !== runDate) return;
      if (row[idCol] === keepRunId) return;
      if (!isTruthyFlag(row[flagCol])) return;
      if (match.scope !== undefined && (scopeCol < 0 ? "all" : (row[scopeCol] ?? "all")) !== match.scope) return;
      if (match.category !== undefined && (categoryCol < 0 ? "" : (row[categoryCol] ?? "")) !== match.category) return;
      updates.push({ range: `${tab}!${flagLetter}${String(idx + 1)}`, values: [["FALSE"]] });
    });
    if (updates.length === 0) return 0;
    await this.queue.enqueue(`markLatest ${tab} ${runDate}`, () =>
      this.client.batchUpdate(this.spreadsheetId, updates),
    );
    return updates.length;
  }
}

function isTruthyFlag(cell: string | undefined): boolean {
  if (cell === undefined) return false;
  const s = cell.trim().toLowerCase();
  return s === "true" || s === "1";
}

/** Skip row 0 (header); bad rows are counted, never thrown. */
function parseDataRows<T>(values: string[][], parse: (cells: string[]) => T): ReadResult<T> {
  const rows: T[] = [];
  let warnings = 0;
  values.forEach((cells, idx) => {
    if (idx === 0) return;
    if (cells.length === 0 || cells.every((c) => c === "")) return; // blank row, ignore silently
    try {
      rows.push(parse(cells));
    } catch (error) {
      if (error instanceof RowParseError) warnings += 1;
      else throw error;
    }
  });
  return { rows, warnings, ageS: 0 };
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
