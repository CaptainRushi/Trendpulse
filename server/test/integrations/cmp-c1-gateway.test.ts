import { describe, expect, it } from "vitest";
import { FakeComposioGateway } from "../../src/integrations/composio/fake-gateway.js";
import { RestComposioGateway, type CallRecord } from "../../src/integrations/composio/gateway.js";
import { loadToolLock } from "../../src/integrations/composio/tool-map.js";

const PINNED = { ...loadToolLock(), version: "20260817_00" };

async function seedSheet(gateway: FakeComposioGateway): Promise<string> {
  const created = (await gateway.execute("createSpreadsheet", { title: "TrendPulse-TEST" })).data as {
    spreadsheetId: string;
  };
  await gateway.execute("addSheet", { spreadsheet_id: created.spreadsheetId, title: "raw_trends" });
  return created.spreadsheetId;
}

describe("CMP-14 gateway contract (fake)", () => {
  it("RAW keeps formulas literal, USER_ENTERED marks them", async () => {
    const gateway = new FakeComposioGateway();
    const id = await seedSheet(gateway);
    await gateway.execute("writeRange", {
      spreadsheet_id: id,
      range: "raw_trends!A1",
      values: [["=HYPERLINK(1)", "2026-10-05", "plain"]],
      value_input_option: "RAW",
    });
    await gateway.execute("writeRange", {
      spreadsheet_id: id,
      range: "raw_trends!A2",
      values: [["=HYPERLINK(1)", "2026-10-05", "plain"]],
      value_input_option: "USER_ENTERED",
    });
    const read = (await gateway.execute("readRanges", {
      spreadsheet_id: id,
      ranges: ["raw_trends!A1:C2"],
    })).data as { valueRanges: { values: string[][] }[] };
    const rows = read.valueRanges[0]?.values ?? [];
    expect(rows[0]).toEqual(["=HYPERLINK(1)", "2026-10-05", "plain"]);
    expect(rows[1]?.[0]).toContain("FORMULA(");
    expect(rows[1]?.[1]).toContain("DATE(");
  });

  it("append returns a parseable updated range; multi-update and delete work", async () => {
    const gateway = new FakeComposioGateway();
    const id = await seedSheet(gateway);
    const appended = (await gateway.execute("appendRows", {
      spreadsheet_id: id,
      range: "raw_trends",
      values: [["a", "b"], ["c", "d"]],
      value_input_option: "RAW",
    })).data as { updatedRange: string };
    expect(appended.updatedRange).toMatch(/^raw_trends!A\d+:B\d+$/);
    await gateway.execute("updateRanges", {
      spreadsheet_id: id,
      range: undefined,
      data: [
        { range: "raw_trends!A1", values: [["z"]] },
        { range: "raw_trends!B2", values: [["y"]] },
      ],
      value_input_option: "RAW",
    });
    await gateway.execute("deleteRows", { spreadsheet_id: id, tab: "raw_trends", start_index: 0, end_index_exclusive: 1 });
    const read = (await gateway.execute("readRanges", { spreadsheet_id: id, ranges: ["raw_trends"] })).data as {
      valueRanges: { values: string[][] }[];
    };
    expect(read.valueRanges[0]?.values[0]).toEqual(["c", "y"]);
  });

  it("429 carries Retry-After; ambiguous failure still applies the write", async () => {
    const gateway = new FakeComposioGateway();
    const id = await seedSheet(gateway);
    gateway.failNext(429, "quota exceeded", 7);
    const limited = await gateway.execute("appendRows", { spreadsheet_id: id, range: "raw_trends", values: [["x"]] });
    expect(limited.ok).toBe(false);
    expect(limited.status).toBe(429);
    expect(limited.retryAfterSeconds).toBe(7);
    gateway.ambiguousNext();
    const ambiguous = await gateway.execute("appendRows", { spreadsheet_id: id, range: "raw_trends", values: [["kept"]] });
    expect(ambiguous.ok).toBe(false);
    const read = (await gateway.execute("readRanges", { spreadsheet_id: id, ranges: ["raw_trends"] })).data as {
      valueRanges: { values: string[][] }[];
    };
    expect(read.valueRanges[0]?.values.flat()).toContain("kept");
  });

  it("records every call via onCall", async () => {
    const seen: CallRecord[] = [];
    const real = new RestComposioGateway(
      {
        apiKey: "k",
        userId: "u",
        timeoutMs: 1000,
        fetchImpl: () => Promise.resolve(new Response(JSON.stringify({ successful: true, data: {} }), { status: 200 })),
        onCall: (record) => seen.push(record),
      },
      PINNED,
    );
    await real.execute("addSheet", { spreadsheet_id: "s", title: "t" });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.slug).toBe("GOOGLESHEETS_ADD_SHEET");
    expect(seen[0]?.ok).toBe(true);
  });

  it("redacts the API key from errors and times out hanging calls", async () => {
    const key = "secret-key-123";
    const leaking = new RestComposioGateway(
      {
        apiKey: key,
        userId: "u",
        timeoutMs: 5000,
        fetchImpl: () =>
          Promise.resolve(new Response(JSON.stringify({ successful: false, error: `bad ${key} key` }), { status: 200 })),
      },
      PINNED,
    );
    const failed = await leaking.execute("addSheet", {});
    expect(failed.ok).toBe(false);
    expect(failed.error ?? "").not.toContain(key);
    expect(failed.error ?? "").toContain("[REDACTED]");
    const hanging = new RestComposioGateway(
      {
        apiKey: key,
        userId: "u",
        timeoutMs: 20,
        fetchImpl: ((_url: unknown, init?: { signal?: AbortSignal }) => new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            const aborted = new Error("fetch aborted");
            aborted.name = "AbortError";
            reject(aborted);
          });
        })) as typeof fetch,
      },
      PINNED,
    );
    const timedOut = await hanging.execute("addSheet", {});
    expect(timedOut.ok).toBe(false);
    expect(timedOut.error ?? "").toContain("timed out");
  });

  it("unpinned lock blocks execute without network (CMP-03 at gateway level)", async () => {
    let fetched = false;
    const gateway = new RestComposioGateway(
      {
        apiKey: "k",
        userId: "u",
        timeoutMs: 1000,
        fetchImpl: () => {
          fetched = true;
          return Promise.resolve(new Response("{}", { status: 200 }));
        },
      },
      loadToolLock(),
    );
    const result = await gateway.execute("appendRows", {});
    expect(result.ok).toBe(false);
    expect(result.error ?? "").toContain("not pinned");
    expect(fetched).toBe(false);
  });

  it("createGateway refuses an empty key with COMPOSIO_NOT_CONFIGURED", async () => {
    const { createGateway } = await import("../../src/integrations/composio/gateway.js");
    expect(() => createGateway({ apiKey: "", userId: "u", timeoutMs: 1000 })).toThrowError(/COMPOSIO_API_KEY/);
  });
});

describe("CMP-14 fake usage sanity", () => {
  it("counts calls for budget math", async () => {
    const gateway = new FakeComposioGateway();
    const id = await seedSheet(gateway);
    await gateway.execute("appendRows", { spreadsheet_id: id, range: "raw_trends", values: [["x"]], value_input_option: "RAW" });
    expect(gateway.calls.length).toBeGreaterThan(0);
    expect(gateway.calls.every((c) => typeof c.latencyMs === "number")).toBe(true);
  });
});
