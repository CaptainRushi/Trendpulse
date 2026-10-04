/**
 * FakeComposioGateway (docs/15 PACKAGE C1) — in-memory spreadsheet model with
 * the same execute(op, args) signature as the real gateway. Emulates RAW vs
 * USER_ENTERED, append updated-ranges, multi-range updates, row deletion,
 * 429+Retry-After, timeouts and ambiguous-success (write happens, call fails).
 */
import type { CallRecord, ComposioGateway, ExecuteResult } from "./gateway.js";

type Cell = string | number | boolean;

interface FakeTab {
  id: number;
  title: string;
  values: Cell[][];
}

interface FakeSheet {
  id: string;
  title: string;
  tabs: FakeTab[];
  nextTabId: number;
}

export interface RecordedCall extends CallRecord {
  op: string;
}

interface PendingFailure {
  status: number;
  message: string;
  retryAfterSeconds?: number | undefined;
  applyWrite: boolean;
}

function colToIndex(col: string): number {
  let n = 0;
  for (const ch of col.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

function indexToCol(n: number): string {
  let s = "";
  let v = n + 1;
  while (v > 0) {
    const r = (v - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    v = Math.floor((v - 1) / 26);
  }
  return s;
}

const DATE_LIKE = /^\d{4}-\d{2}-\d{2}/;

/** USER_ENTERED coercion marker; RAW never produces these. */
function coerce(cell: unknown, raw: boolean): Cell {
  if (typeof cell === "number" || typeof cell === "boolean") return cell;
  const text = String(cell);
  if (raw) return text;
  if (/^[=+\-@]/.test(text)) return `FORMULA(${text})`;
  if (DATE_LIKE.test(text)) return `DATE(${text})`;
  return text;
}

interface ParsedRange {
  tab: string;
  startCol: number;
  startRow: number;
  endCol: number;
  endRow: number;
}

/** Minimal A1 parser: "Tab", "Tab!1:1", "Tab!A:A", "Tab!A2:C5". Open-ended. */
function parseRange(range: string, tabSize: (tab: string) => { rows: number; cols: number }): ParsedRange {
  const bang = range.indexOf("!");
  const tab = (bang < 0 ? range : range.slice(0, bang)).replace(/^'(.*)'$/, "$1");
  const spec = bang < 0 ? "" : range.slice(bang + 1);
  const size = tabSize(tab);
  if (spec === "") return { tab, startCol: 0, startRow: 0, endCol: Math.max(0, size.cols - 1), endRow: Math.max(0, size.rows - 1) };
  const rowOnly = spec.match(/^(\d+):(\d+)$/);
  if (rowOnly) {
    const r = Number(rowOnly[1]) - 1;
    return { tab, startCol: 0, startRow: r, endCol: Math.max(0, size.cols - 1), endRow: r };
  }
  const colOnly = spec.match(/^([A-Za-z]+):([A-Za-z]+)$/);
  if (colOnly) {
    return { tab, startCol: colToIndex(colOnly[1] as string), startRow: 0, endCol: colToIndex(colOnly[2] as string), endRow: Math.max(0, size.rows - 1) };
  }
  const cell = spec.match(/^([A-Za-z]+)(\d+)(?::([A-Za-z]+)(\d+))?$/);
  if (cell) {
    const sc = colToIndex(cell[1] as string);
    const sr = Number(cell[2]) - 1;
    return {
      tab,
      startCol: sc,
      startRow: sr,
      endCol: cell[3] ? colToIndex(cell[3]) : sc,
      endRow: cell[4] ? Number(cell[4]) - 1 : sr,
    };
  }
  throw new Error(`fake-gateway: unsupported range '${range}'`);
}

export class FakeComposioGateway implements ComposioGateway {
  private sheets = new Map<string, FakeSheet>();
  private nextSheet = 1;
  private failures: PendingFailure[] = [];
  readonly calls: RecordedCall[] = [];

  /** Next execute fails with status/message without applying the write. */
  failNext(status: number, message: string, retryAfterSeconds?: number): void {
    this.failures.push({ status, message, retryAfterSeconds, applyWrite: false });
  }

  private strArg(args: Record<string, unknown>, key: string, fallback: string): string {
    const value = args[key];
    return typeof value === "string" ? value : fallback;
  }

  /** Next execute applies the write, then reports failure (CMP-05 retry path). */
  ambiguousNext(message = "timeout after write"): void {
    this.failures.push({ status: 504, message, applyWrite: true });
  }

  private sheet(id: string): FakeSheet {
    const sheet = this.sheets.get(id);
    if (!sheet) throw new Error(`fake-gateway: unknown spreadsheet '${id}'`);
    return sheet;
  }

  private tab(sheet: FakeSheet, title: string): FakeTab {
    const found = sheet.tabs.find((t) => t.title === title);
    if (!found) throw new Error(`fake-gateway: unknown tab '${title}'`);
    return found;
  }

  private writeCells(tab: FakeTab, range: ParsedRange, values: unknown[][], raw: boolean): void {
    values.forEach((row, ri) => {
      row.forEach((cell, ci) => {
        const r = range.startRow + ri;
        const c = range.startCol + ci;
        while (tab.values.length <= r) tab.values.push([]);
        const target = tab.values[r] as Cell[];
        while (target.length <= c) target.push("");
        target[c] = coerce(cell, raw);
      });
    });
  }

  execute(op: string, args: Record<string, unknown>): Promise<ExecuteResult> {
    const started = Date.now();
    const done = (result: Omit<ExecuteResult, "latencyMs">): ExecuteResult => {
      const full = { ...result, latencyMs: Date.now() - started };
      this.calls.push({ op, slug: op, ok: full.ok, latencyMs: full.latencyMs });
      return full;
    };
    const failure = this.failures.shift();
    try {
      if (failure) {
        if (failure.applyWrite) this.apply(op, args);
        const result = done({
          ok: false,
          error: failure.message,
          status: failure.status,
          retryAfterSeconds: failure.retryAfterSeconds,
        });
        return Promise.resolve(result);
      }
      return Promise.resolve(done({ ok: true, data: this.apply(op, args), status: 200 }));
    } catch (error) {
      return Promise.resolve(
        done({ ok: false, error: error instanceof Error ? error.message : String(error), status: 400 }),
      );
    }
  }

  private apply(op: string, args: Record<string, unknown>): unknown {
    switch (op) {
      case "createSpreadsheet": {
        const title = this.strArg(args, "title", "Untitled");
        const id = `fake-sheet-${String(this.nextSheet++)}`;
        this.sheets.set(id, { id, title, tabs: [{ id: 0, title: "Sheet1", values: [] }], nextTabId: 1 });
        return { spreadsheetId: id, spreadsheetUrl: `https://docs.google.com/spreadsheets/d/${id}`, title };
      }
      case "spreadsheetInfo": {
        const sheet = this.sheet(this.strArg(args, "spreadsheet_id", ""));
        return {
          spreadsheet_id: sheet.id,
          title: sheet.title,
          tabs: sheet.tabs.map((t) => ({ title: t.title, sheet_id: t.id })),
        };
      }
      case "addSheet": {
        const sheet = this.sheet(this.strArg(args, "spreadsheet_id", ""));
        const title = this.strArg(args, "title", "");
        if (!sheet.tabs.some((t) => t.title === title)) {
          // Mirror the §11.1 rule: drop the untouched default Sheet1.
          const first: FakeTab | undefined = sheet.tabs[0];
          if (sheet.tabs.length === 1 && first && first.title === "Sheet1" && first.values.length === 0) {
            sheet.tabs = [];
          }
          sheet.tabs.push({ id: sheet.nextTabId++, title, values: [] });
        }
        return {};
      }
      case "writeRange": {
        const sheet = this.sheet(this.strArg(args, "spreadsheet_id", ""));
        const range = parseRange(this.strArg(args, "range", ""), (t) => this.tabSize(sheet, t));
        this.writeCells(this.tab(sheet, range.tab), range, args["values"] as unknown[][], this.isRaw(args));
        return { updated_cells: (args["values"] as unknown[][]).flat().length };
      }
      case "appendRows": {
        const sheet = this.sheet(this.strArg(args, "spreadsheet_id", ""));
        const tab = this.tab(sheet, this.strArg(args, "range", ""));
        const values = args["values"] as unknown[][];
        const startRow = tab.values.length;
        const raw = this.isRaw(args);
        values.forEach((row) => tab.values.push(row.map((c) => coerce(c, raw))));
        const endRow = tab.values.length - 1;
        const cols = Math.max(...values.map((r) => r.length), 1);
        return { updatedRange: `${tab.title}!A${String(startRow + 1)}:${indexToCol(cols - 1)}${String(endRow + 1)}` };
      }
      case "readRanges": {
        const sheet = this.sheet(this.strArg(args, "spreadsheet_id", ""));
        const ranges = args["ranges"] as string[];
        return {
          valueRanges: ranges.map((r) => {
            const parsed = parseRange(r, (t) => this.tabSize(sheet, t));
            const tab = this.tab(sheet, parsed.tab);
            const values: Cell[][] = [];
            for (let rr = parsed.startRow; rr <= Math.min(parsed.endRow, tab.values.length - 1); rr++) {
              values.push((tab.values[rr] ?? []).slice(parsed.startCol, parsed.endCol + 1));
            }
            return { range: r, values };
          }),
        };
      }
      case "updateRanges": {
        const sheet = this.sheet(this.strArg(args, "spreadsheet_id", ""));
        const data = args["data"] as { range: string; values: unknown[][] }[];
        const raw = this.isRaw(args);
        data.forEach((u) => {
          const parsed = parseRange(u.range, (t) => this.tabSize(sheet, t));
          this.writeCells(this.tab(sheet, parsed.tab), parsed, u.values, raw);
        });
        return { updatedRanges: data.map((u) => u.range) };
      }
      case "deleteRows": {
        const sheet = this.sheet(this.strArg(args, "spreadsheet_id", ""));
        const tab = this.resolveTab(sheet, args);
        const start = Number(args["start_index"]);
        const end = Number(args["end_index_exclusive"]);
        tab.values.splice(start, end - start);
        return { deleted: end - start };
      }
      case "formatHeader": {
        return { ok: true };
      }
      default:
        throw new Error(`fake-gateway: unknown op '${op}'`);
    }
  }

  private isRaw(args: Record<string, unknown>): boolean {
    return (args["value_input_option"] ?? "RAW") === "RAW";
  }

  private tabSize(sheet: FakeSheet, title: string): { rows: number; cols: number } {
    const tab = this.tab(sheet, title);
    return {
      rows: tab.values.length,
      cols: Math.max(...tab.values.map((r) => r.length), 0),
    };
  }

  private resolveTab(sheet: FakeSheet, args: Record<string, unknown>): FakeTab {
    if (args["tab"] !== undefined) return this.tab(sheet, this.strArg(args, "tab", ""));
    const id = Number(args["sheet_id"]);
    const found = sheet.tabs.find((t) => t.id === id);
    if (!found) throw new Error(`fake-gateway: unknown sheet_id '${this.strArg(args, "sheet_id", "?")}'`);
    return found;
  }
}
