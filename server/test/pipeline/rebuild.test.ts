import { describe, expect, it } from "vitest";
import { applySeenRebuild, planSeenRebuild } from "../../src/pipeline/rebuild.js";
import { makeRawItem } from "../sorting/helpers.js";
import { openTestDb } from "../pipeline/helpers.js";

describe("planSeenRebuild", () => {
  it("aggregates first/last sightings per hash with the earliest source", () => {
    const a = makeRawItem({ source: "rss", url: "https://example.com/a" });
    const b = makeRawItem({ source: "github", url: "https://example.com/b" });
    const plan = planSeenRebuild([
      { ...a, collected_at: "2026-09-28T06:00:00.000Z" },
      { ...a, collected_at: "2026-09-30T06:00:00.000Z" },
      { ...b, collected_at: "2026-09-29T06:00:00.000Z" },
    ]);
    expect(plan).toHaveLength(2);
    const entry = plan.find((e) => e.content_hash === a.content_hash);
    expect(entry).toMatchObject({
      first_seen_date: "2026-09-28",
      last_seen_date: "2026-09-30",
      source: "rss",
    });
  });

  it("returns no entries for no rows", () => {
    expect(planSeenRebuild([])).toEqual([]);
  });
});

describe("applySeenRebuild", () => {
  it("inserts new hashes and widens existing ones without narrowing", () => {
    const db = openTestDb();
    try {
      db.prepare(
        "INSERT INTO seen_items (content_hash, first_seen_date, last_seen_date, source) VALUES ('h', '2026-09-29', '2026-09-29', 'rss')",
      ).run();
      const result = applySeenRebuild(db, [
        { content_hash: "h", first_seen_date: "2026-09-27", last_seen_date: "2026-09-29", source: "github" },
        { content_hash: "n", first_seen_date: "2026-09-30", last_seen_date: "2026-09-30", source: "rss" },
      ]);
      expect(result).toEqual({ inserted: 1, updated: 1 });
      const row = db.prepare("SELECT first_seen_date, last_seen_date, source FROM seen_items WHERE content_hash = 'h'").get() as {
        first_seen_date: string;
        last_seen_date: string;
        source: string;
      };
      expect(row).toMatchObject({ first_seen_date: "2026-09-27", last_seen_date: "2026-09-29", source: "rss" });
    } finally {
      db.close();
    }
  });
});
