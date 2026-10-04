import { describe, expect, it } from "vitest";
import { ComposioSheetsClient, mapGatewayError } from "../../src/sheets/composioClient.js";
import { FakeComposioGateway } from "../../src/integrations/composio/fake-gateway.js";
import { loadToolLock } from "../../src/integrations/composio/tool-map.js";
import { SheetsRepo } from "../../src/sheets/repo.js";
import { SheetsWriteQueue } from "../../src/sheets/queue.js";
import { RAW_TRENDS_HEADERS, SORTED_TRENDS_HEADERS } from "../../src/sheets/schema.js";
import { FakeSheetsClient } from "../fakes/fakeSheetsClient.js";

const PINNED = { ...loadToolLock(), version: "20260817_00" };
const instantQueue = (): SheetsWriteQueue =>
  new SheetsWriteQueue({ sleep: () => Promise.resolve(), now: () => 0 });

function makeClient(gateway: FakeComposioGateway): ComposioSheetsClient {
  return new ComposioSheetsClient({ apiKey: "k", gateway, queue: instantQueue(), lock: PINNED });
}

async function initSheet(client: ComposioSheetsClient, title = "TrendPulse-TEST"): Promise<string> {
  const created = await client.createSpreadsheet(title);
  const repo = new SheetsRepo(client, { spreadsheetId: created.spreadsheetId, queue: instantQueue() });
  await repo.init();
  return created.spreadsheetId;
}

describe("CMP-04/12 init and create-for-me", () => {
  it("creates missing tabs with RAW headers, second init is a no-op, keeps edited headers", async () => {
    const gateway = new FakeComposioGateway();
    const client = makeClient(gateway);
    const id = await initSheet(client);
    const titles = await client.getTabTitles(id);
    expect(titles).toContain("raw_trends");
    expect(titles).toContain("runs_log");
    const first = await client.getFirstRow(id, "raw_trends");
    expect(first?.slice(0, 3)).toEqual(["id", "run_id", "collected_at"]);
    const callsBefore = gateway.calls.length;
    const repo = new SheetsRepo(client, { spreadsheetId: id, queue: instantQueue() });
    const second = await repo.init();
    expect(second.created).toEqual([]);
    expect(second.headersWritten).toEqual([]);
    expect(gateway.calls.length).toBeGreaterThan(callsBefore); // reads only, no writes
    // Human-edited header is never overwritten.
    await client.writeFirstRow(id, "raw_trends", ["id", "CHANGED", ...RAW_TRENDS_HEADERS.slice(2)]);
    await repo.init();
    expect(await client.getFirstRow(id, "raw_trends")).toContain("CHANGED");
  });

  it("empty tab reads null first row", async () => {
    const gateway = new FakeComposioGateway();
    const client = makeClient(gateway);
    const created = await client.createSpreadsheet("TrendPulse-TEST");
    await client.addTab(created.spreadsheetId, "raw_trends");
    await expect(client.getFirstRow(created.spreadsheetId, "raw_trends")).resolves.toBeNull();
  });
});

describe("CMP-05 idempotent append after ambiguous failure", () => {
  it("ambiguous write is not duplicated; hard failure retries once", async () => {
    const gateway = new FakeComposioGateway();
    const client = makeClient(gateway);
    const id = await initSheet(client);
    await client.appendRows(id, "raw_trends", [["k1", "r1"], ["k2", "r1"]]);
    gateway.ambiguousNext();
    await client.appendRows(id, "raw_trends", [["k3", "r2"], ["k4", "r2"]]);
    const afterAmbiguous = await client.getAllValues(id, "raw_trends");
    expect(afterAmbiguous.map((r) => r[0])).toEqual([...RAW_TRENDS_HEADERS.slice(0, 1), "k1", "k2", "k3", "k4"]);
    gateway.failNext(500, "boom");
    await client.appendRows(id, "raw_trends", [["k5", "r3"]]);
    const afterRetry = await client.getAllValues(id, "raw_trends");
    expect(afterRetry.map((r) => r[0])).toContain("k5");
  });

  it("600 rows go in two batches of at most 500", async () => {
    const gateway = new FakeComposioGateway();
    const client = makeClient(gateway);
    const id = await initSheet(client);
    const repo = new SheetsRepo(client, { spreadsheetId: id, queue: instantQueue() });
    const records = Array.from({ length: 600 }, (_, i) => ({
      id: `k${String(i)}`,
      run_id: "r",
      collected_at: "2026-10-04T06:00:00Z",
      source: "hackernews" as const,
      source_item_id: null,
      url: "https://example.com/x",
      title: `t${String(i)}`,
      snippet: "",
      author: null,
      published_at: null,
      engagement_score: null,
      engagement_extra: {},
      engagement_norm: 0,
      language: null,
      region: null,
      content_hash: `h${String(i)}`,
      merged_sources: [],
      extraction_model: null,
      source_label: null,
    }));
    const result = await repo.appendRaw(records);
    expect(result.batches).toBe(2);
    expect(gateway.calls.filter((c) => c.op === "appendRows")).toHaveLength(2);
  });
});

describe("CMP-06 RAW injection safety", () => {
  it("formula-like, sign-led and date-like strings stay literal", async () => {
    const gateway = new FakeComposioGateway();
    const client = makeClient(gateway);
    const id = await initSheet(client);
    const tricky = ["=HYPERLINK(1)", "+1", "-2", "@SUM(1)", "2026-10-05", "x".repeat(5000), "42", "TRUE"];
    await client.appendRows(id, "raw_trends", [tricky]);
    const values = await client.getAllValues(id, "raw_trends");
    expect(values[values.length - 1]).toEqual(tricky);
  });
});

describe("CMP-08 markLatest flips in ONE updateRanges call", () => {
  it("only stale rows of the date flip", async () => {
    const gateway = new FakeComposioGateway();
    const client = makeClient(gateway);
    const id = await initSheet(client);
    const row = (topic: string, run: string, latest: string): string[] => {
      const cells = new Array(SORTED_TRENDS_HEADERS.length).fill("");
      cells[0] = topic;
      cells[1] = run;
      cells[2] = "2026-10-04";
      cells[23] = latest;
      return cells as string[];
    };
    await client.appendRows(id, "sorted_trends", [row("t1", "run-old", "TRUE"), row("t2", "run-new", "TRUE")]);
    const repo = new SheetsRepo(client, { spreadsheetId: id, queue: instantQueue() });
    const flipped = await repo.markLatest("2026-10-04", "run-new");
    expect(flipped.flipped).toBe(1);
    expect(gateway.calls.filter((c) => c.op === "updateRanges")).toHaveLength(1);
    const values = await client.getAllValues(id, "sorted_trends");
    expect(values[1]?.[23]).toBe("FALSE");
    expect(values[2]?.[23]).toBe("TRUE");
  });
});

describe("CMP-11 error mapping", () => {
  it("maps gateway failures to SheetsApiError codes", () => {
    expect(mapGatewayError("appendRows", { ok: false, error: "denied", status: 403, latencyMs: 1 }).errorCode).toBe("FORBIDDEN");
    const quota = mapGatewayError("appendRows", { ok: false, error: "slow", status: 429, latencyMs: 1, retryAfterSeconds: 7 });
    expect(quota.errorCode).toBe("QUOTA");
    expect(quota.retryAfterSeconds).toBe(7);
    expect(
      mapGatewayError("readRanges", { ok: false, error: "Requested entity was not found.", status: 404, latencyMs: 1 }).errorCode,
    ).toBe("SHEET_NOT_FOUND");
    expect(
      mapGatewayError("appendRows", { ok: false, error: "Unable to parse range: 'x'!A1", status: 400, latencyMs: 1 }).errorCode,
    ).toBe("RANGE_NOT_FOUND");
  });

  it("live 403 surfaces as FORBIDDEN through the client", async () => {
    const gateway = new FakeComposioGateway();
    const client = makeClient(gateway);
    gateway.failNext(403, "denied");
    let code: string | undefined;
    try {
      await client.getTabTitles("nope");
    } catch (error) {
      code = (error as { errorCode?: string }).errorCode;
    }
    expect(code).toBe("FORBIDDEN");
  });
});

describe("CMP-14 client parity (fake vs gateway-backed)", () => {
  it("append + read round-trips identically", async () => {
    const fake = new FakeSheetsClient();
    await fake.addTab("raw_trends");
    await fake.writeFirstRow("s", "raw_trends", [...RAW_TRENDS_HEADERS]);
    await fake.appendRows("s", "raw_trends", [["k1", "r1"], ["=X", "+1"]]);
    const gateway = new FakeComposioGateway();
    const client = makeClient(gateway);
    const created = await client.createSpreadsheet("TrendPulse-TEST");
    await client.addTab(created.spreadsheetId, "raw_trends");
    await client.writeFirstRow(created.spreadsheetId, "raw_trends", [...RAW_TRENDS_HEADERS]);
    await client.appendRows(created.spreadsheetId, "raw_trends", [["k1", "r1"], ["=X", "+1"]]);
    expect(await client.getAllValues(created.spreadsheetId, "raw_trends")).toEqual(await fake.getAllValues("s", "raw_trends"));
  });
});
