import { describe, expect, it } from "vitest";
import { SheetsRepo } from "../../src/sheets/repo.js";
import { SheetsWriteQueue } from "../../src/sheets/queue.js";
import { RAW_TRENDS_HEADERS } from "../../src/sheets/schema.js";
import { FakeSheetsClient } from "../fakes/fakeSheetsClient.js";

function testRepo(client: FakeSheetsClient): SheetsRepo {
  return new SheetsRepo(client, {
    spreadsheetId: "test-sheet",
    cacheTtlS: 60,
    queue: new SheetsWriteQueue({ minGapMs: 0, sleep: () => Promise.resolve() }),
  });
}

function rawRow(id: string, collectedAt: string): string[] {
  return [
    id,
    "run-1",
    collectedAt,
    "rss",
    "",
    `https://example.com/${id}`,
    `Title ${id}`,
    "",
    "",
    "",
    "",
    "{}",
    "1",
    "en",
    "",
    `hash-${id}`,
    "[]",
    "",
  ];
}

function seedAged(client: FakeSheetsClient): void {
  client.tabs.set("raw_trends", [
    [...RAW_TRENDS_HEADERS],
    rawRow("old-sep", "2026-09-20T06:00:00.000Z"),
    rawRow("old-sep-2", "2026-09-21T06:00:00.000Z"),
    rawRow("old-aug", "2026-08-05T06:00:00.000Z"),
    rawRow("fresh", "2026-09-29T06:00:00.000Z"),
    rawRow("bogus", "not-a-date"),
  ]);
}

describe("retainRaw", () => {
  it("archives aged rows by month, then deletes them", async () => {
    const client = new FakeSheetsClient();
    seedAged(client);
    const repo = testRepo(client);
    const result = await repo.retainRaw({
      runDate: "2026-09-30",
      retentionDays: 3, // cutoff 2026-09-27
      retentionMode: "archive",
    });
    expect(result).toMatchObject({ archived: 3, deleted: 3, warnings: 1 });
    expect(result.tabs.sort()).toEqual(["archive_2026_08", "archive_2026_09"]);
    expect(client.rowCount("archive_2026_09")).toBe(3); // header + 2
    expect(client.rowCount("archive_2026_08")).toBe(2); // header + 1
    // Archive tabs carry the canonical header.
    expect(client.tabs.get("archive_2026_09")?.[0]).toEqual([...RAW_TRENDS_HEADERS]);
    // raw_trends keeps header + fresh + malformed only.
    const remaining = client.tabs.get("raw_trends") ?? [];
    expect(remaining).toHaveLength(3);
    expect(remaining[1]?.[0]).toBe("fresh");
    expect(remaining[2]?.[0]).toBe("bogus");
  });

  it("delete mode removes without archiving", async () => {
    const client = new FakeSheetsClient();
    seedAged(client);
    const repo = testRepo(client);
    const result = await repo.retainRaw({
      runDate: "2026-09-30",
      retentionDays: 3,
      retentionMode: "delete",
    });
    expect(result).toMatchObject({ archived: 0, deleted: 3, warnings: 1, tabs: [] });
    expect(client.tabs.has("archive_2026_09")).toBe(false);
    expect(client.rowCount("raw_trends")).toBe(3);
  });

  it("is a no-op on a missing or fresh tab", async () => {
    const client = new FakeSheetsClient();
    const repo = testRepo(client);
    await expect(
      repo.retainRaw({ runDate: "2026-09-30", retentionDays: 30, retentionMode: "archive" }),
    ).resolves.toMatchObject({ archived: 0, deleted: 0 });

    client.tabs.set("raw_trends", [[...RAW_TRENDS_HEADERS], rawRow("fresh", "2026-09-30T06:00:00.000Z")]);
    await expect(
      repo.retainRaw({ runDate: "2026-09-30", retentionDays: 30, retentionMode: "delete" }),
    ).resolves.toMatchObject({ archived: 0, deleted: 0 });
    expect(client.rowCount("raw_trends")).toBe(2);
  });
});
