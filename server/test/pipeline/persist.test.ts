import { describe, expect, it } from "vitest";
import {
  persistRawItems,
  prepareRunItems,
  readPendingRunItems,
} from "../../src/pipeline/persist.js";
import { SheetsRepo } from "../../src/sheets/repo.js";
import { SheetsWriteQueue } from "../../src/sheets/queue.js";
import { FakeSheetsClient } from "../fakes/fakeSheetsClient.js";
import { insertRun, makeDraft, openTestDb } from "./helpers.js";

const RUN_DATE = "2026-09-30";

function testRepo(client: FakeSheetsClient): SheetsRepo {
  return new SheetsRepo(client, {
    spreadsheetId: "test-sheet",
    cacheTtlS: 60,
    queue: new SheetsWriteQueue({ minGapMs: 0, sleep: () => Promise.resolve() }),
  });
}

function seenHashes(db: ReturnType<typeof openTestDb>): string[] {
  const rows = db.prepare("SELECT content_hash FROM seen_items").all() as { content_hash: string }[];
  return rows.map((row) => row.content_hash).sort();
}

describe("prepareRunItems", () => {
  it("writes a pending items_run working set with valid records", () => {
    const db = openTestDb();
    insertRun(db, "run-1", RUN_DATE);
    try {
      const result = prepareRunItems(db, {
        runId: "run-1",
        runDate: RUN_DATE,
        drafts: [
          makeDraft({ url: "https://example.com/a", title: "Alpha story" }),
          makeDraft({ url: "https://example.com/b", title: "Beta story" }),
        ],
        dedupeDays: 3,
      });
      expect(result.stats).toMatchObject({ input: 2, output: 2, merged: 0, seenDropped: 0 });
      expect(result.items).toHaveLength(2);
      const rows = db.prepare("SELECT id, persisted, sort_status FROM items_run").all() as {
        id: string;
        persisted: number;
        sort_status: string;
      }[];
      expect(rows).toHaveLength(2);
      for (const row of rows) {
        expect(row.persisted).toBe(0);
        expect(row.sort_status).toBe("pending");
      }
      // Ids are ULIDs, distinct per item.
      expect(new Set(result.items.map((i) => i.id)).size).toBe(2);
      expect(result.items.every((i) => i.run_id === "run-1")).toBe(true);
    } finally {
      db.close();
    }
  });

  it("fails fast on a second prepare for the same run", () => {
    const db = openTestDb();
    insertRun(db, "run-1", RUN_DATE);
    try {
      const options = {
        runId: "run-1",
        runDate: RUN_DATE,
        drafts: [makeDraft()],
        dedupeDays: 3,
      };
      prepareRunItems(db, options);
      expect(() => prepareRunItems(db, options)).toThrow(/already has an items_run/);
    } finally {
      db.close();
    }
  });

  it("drops bad URLs and reports stats", () => {
    const db = openTestDb();
    insertRun(db, "run-1", RUN_DATE);
    try {
      const result = prepareRunItems(db, {
        runId: "run-1",
        runDate: RUN_DATE,
        drafts: [makeDraft({ url: "javascript:alert(1)" }), makeDraft({ title: "Ok" })],
        dedupeDays: 3,
      });
      expect(result.stats.droppedBadUrl).toBe(1);
      expect(result.items).toHaveLength(1);
    } finally {
      db.close();
    }
  });
});

describe("persistRawItems", () => {
  it("appends pending rows, marks persisted, records keeper + absorbed hashes", async () => {
    const db = openTestDb();
    insertRun(db, "run-1", RUN_DATE);
    try {
      const client = new FakeSheetsClient();
      const repo = testRepo(client);
      prepareRunItems(db, {
        runId: "run-1",
        runDate: RUN_DATE,
        drafts: [
          makeDraft({
            source: "hackernews",
            url: "https://example.com/launch?utm_source=hn",
            title: "Startup launches a rocket",
            engagement_score: 100,
          }),
          makeDraft({
            source: "rss",
            url: "https://example.com/launch",
            title: "Same link, other words",
            engagement_score: 1,
          }),
          makeDraft({
            source: "github",
            url: "https://github.com/acme/widget",
            title: "Unrelated widget",
            engagement_score: 9,
          }),
        ],
        dedupeDays: 3,
      });
      const result = await persistRawItems(db, repo, "run-1", RUN_DATE);
      expect(result.appended).toBe(2); // rocket pair merged
      // 2 keepers + 1 absorbed entry, but the absorbed hash equals the keeper
      // hash (same canonical URL) → 2 distinct seen rows.
      expect(result.recordedSeen).toBe(2);
      // Sheet holds header + 2 rows, no sidecar leakage.
      const tab = client.tabs.get("raw_trends") ?? [];
      expect(tab).toHaveLength(3);
      expect(JSON.stringify(tab)).not.toContain("_absorbed");
      // Working set flipped to persisted.
      const remaining = readPendingRunItems(db, "run-1");
      expect(remaining).toHaveLength(0);
      // Keeper + absorbed hashes all seen (absorbed == keeper hash here).
      expect(seenHashes(db)).toHaveLength(2);
      // Merged row carries the absorbed source.
      const merged = tab[1] ?? [];
      expect(JSON.parse(merged[16] ?? "[]") as unknown).toEqual(["rss"]);
    } finally {
      db.close();
    }
  });

  it("sheets failure leaves pending rows and empty seen_items (retry-safe)", async () => {
    const db = openTestDb();
    insertRun(db, "run-1", RUN_DATE);
    try {
      const client = new FakeSheetsClient();
      client.failNext({ method: "appendRows", times: 10, status: 403 });
      const repo = testRepo(client);
      prepareRunItems(db, {
        runId: "run-1",
        runDate: RUN_DATE,
        drafts: [makeDraft()],
        dedupeDays: 3,
      });
      await expect(persistRawItems(db, repo, "run-1", RUN_DATE)).rejects.toThrow();
      expect(readPendingRunItems(db, "run-1")).toHaveLength(1);
      expect(seenHashes(db)).toHaveLength(0);
    } finally {
      db.close();
    }
  });

  it("re-running the same day appends 0 raw rows", async () => {
    const db = openTestDb();
    insertRun(db, "run-1", RUN_DATE);
    insertRun(db, "run-2", RUN_DATE);
    try {
      const client = new FakeSheetsClient();
      const repo = testRepo(client);
      const drafts = [
        makeDraft({ url: "https://example.com/a", title: "Alpha" }),
        makeDraft({ url: "https://example.com/b?utm_source=x", title: "Beta" }),
      ];
      const first = prepareRunItems(db, {
        runId: "run-1",
        runDate: RUN_DATE,
        drafts,
        dedupeDays: 3,
      });
      expect(first.stats.output).toBe(2);
      await persistRawItems(db, repo, "run-1", RUN_DATE);

      // Same collectors, same day, new run id → everything already seen.
      const second = prepareRunItems(db, {
        runId: "run-2",
        runDate: RUN_DATE,
        drafts,
        dedupeDays: 3,
      });
      expect(second.stats.seenDropped).toBe(2);
      expect(second.stats.output).toBe(0);
      const persisted = await persistRawItems(db, repo, "run-2", RUN_DATE);
      expect(persisted.appended).toBe(0);
      expect(client.rowCount("raw_trends")).toBe(3); // header + 2, unchanged
    } finally {
      db.close();
    }
  });

  it("property: same URL with utm params → one row; reorder → same hashes", async () => {
    const db = openTestDb();
    insertRun(db, "run-1", RUN_DATE);
    insertRun(db, "run-9", "2026-10-05");
    try {
      const client = new FakeSheetsClient();
      const repo = testRepo(client);
      const drafts = [
        makeDraft({
          source: "hackernews",
          url: "https://example.com/s?utm_source=hn",
          title: "Story S",
          engagement_score: 10,
        }),
        makeDraft({
          source: "rss",
          url: "https://example.com/s?fbclid=z",
          title: "Story S",
          engagement_score: 1,
        }),
        makeDraft({
          source: "github",
          url: "https://example.com/t",
          title: "Story T",
          engagement_score: 5,
        }),
      ];
      prepareRunItems(db, { runId: "run-1", runDate: RUN_DATE, drafts, dedupeDays: 3 });
      await persistRawItems(db, repo, "run-1", RUN_DATE);
      expect(client.rowCount("raw_trends")).toBe(3); // header + 2 keepers

      const reversed = [...drafts].reverse();
      const again = prepareRunItems(db, {
        runId: "run-9",
        runDate: "2026-10-05", // outside the window so nothing is seen-dropped…
        drafts: reversed,
        dedupeDays: 0, // …and the window disabled: merge alone must agree
      });
      const hashes = again.items.map((i) => i.content_hash).sort();
      const db2 = openTestDb();
      insertRun(db2, "run-8", "2026-10-05");
      try {
        const straight = prepareRunItems(db2, {
          runId: "run-8",
          runDate: "2026-10-05",
          drafts,
          dedupeDays: 0,
        });
        expect(hashes).toEqual(straight.items.map((i) => i.content_hash).sort());
      } finally {
        db2.close();
      }
    } finally {
      db.close();
    }
  });
});
