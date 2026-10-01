import { describe, expect, it } from "vitest";
import {
  cutoffDate,
  filterSeenItems,
  jaccard,
  mergeNearDuplicates,
  NEAR_DUPLICATE_THRESHOLD,
  normalizeTitleForMatch,
  recordSeenItems,
  titleSimilarity,
  trigrams,
} from "../../src/pipeline/dedupe.js";
import { normalizeDrafts } from "../../src/pipeline/normalize.js";
import type { NormalizedItem } from "../../src/pipeline/normalize.js";
import { makeDraft, openTestDb } from "./helpers.js";

function itemWithHash(hash: string): NormalizedItem {
  const [item] = normalizeDrafts([makeDraft({ url: `https://example.com/${hash}` })]).items;
  if (!item) throw new Error("normalize failed in test");
  return { ...item, content_hash: hash };
}

describe("trigrams / jaccard", () => {
  it("builds sliding 3-char grams (lone gram for short strings)", () => {
    expect([...trigrams("abcd")]).toEqual(["abc", "bcd"]);
    expect([...trigrams("ab")]).toEqual(["ab"]);
    expect(trigrams("").size).toBe(0);
  });

  it("jaccard scores identity, disjointness and partial overlap", () => {
    const full = new Set(["a", "b", "c"]);
    expect(jaccard(full, new Set(["a", "b", "c"]))).toBe(1);
    expect(jaccard(full, new Set(["x", "y"]))).toBe(0);
    expect(jaccard(new Set(["a", "b", "c"]), new Set(["b", "c", "d"]))).toBe(0.5);
    expect(jaccard(new Set(), new Set())).toBe(1);
    expect(jaccard(new Set(), full)).toBe(0);
  });

  it("titleSimilarity ignores case and punctuation", () => {
    expect(normalizeTitleForMatch("  Hello,   World! ")).toBe("hello world");
    expect(titleSimilarity("Hello, World!", "hello world")).toBe(1);
    expect(titleSimilarity("OpenAI releases GPT-5", "Cats conquer the moon base")).toBeLessThan(0.3);
  });

  it("threshold is the TRD 0.85", () => {
    expect(NEAR_DUPLICATE_THRESHOLD).toBe(0.85);
  });
});

describe("mergeNearDuplicates", () => {
  it("merges same-URL utm variants even when titles differ (exact-hash pass)", () => {
    const { items } = normalizeDrafts([
      makeDraft({
        source: "hackernews",
        url: "https://example.com/launch?utm_source=hn",
        title: "Startup launches a rocket",
        engagement_score: 100,
      }),
      makeDraft({
        source: "rss",
        url: "https://example.com/launch?utm_medium=rss",
        title: "Completely different headline, same link",
        engagement_score: 5,
      }),
    ]);
    const merged = mergeNearDuplicates(items);
    expect(merged.items).toHaveLength(1);
    expect(merged.kept).toBe(1);
    expect(merged.merged).toBe(1);
    expect(merged.items[0]?.title).toBe("Startup launches a rocket"); // max engagement kept
    expect(merged.items[0]?.merged_sources).toEqual(["rss"]);
    expect(merged.absorbedHashes).toEqual(items[0] ? [items[0].content_hash] : []);
  });

  it("merges near-identical titles across different URLs (trigram pass)", () => {
    const { items } = normalizeDrafts([
      makeDraft({
        source: "github",
        url: "https://github.com/acme/widget",
        title: "Acme releases Widget 2.0 today",
        engagement_score: 500,
      }),
      makeDraft({
        source: "webpage",
        url: "https://blog.example.com/acme-widget-2",
        title: "Acme releases Widget 2.0 today!",
        engagement_score: 3,
      }),
      makeDraft({
        source: "wikipedia",
        url: "https://en.wikipedia.org/wiki/Cat",
        title: "Cat",
        engagement_score: 999,
      }),
    ]);
    expect(titleSimilarity(items[0]?.title ?? "", items[1]?.title ?? "")).toBeGreaterThanOrEqual(
      NEAR_DUPLICATE_THRESHOLD,
    );
    const merged = mergeNearDuplicates(items);
    expect(merged.items).toHaveLength(2);
    expect(merged.items.map((i) => i.source).sort()).toEqual(["github", "wikipedia"]);
    expect(merged.items[0]?.merged_sources).toEqual(["webpage"]);
  });

  it("excludes the keeper's own source from merged_sources", () => {
    const { items } = normalizeDrafts([
      makeDraft({ source: "rss", url: "https://example.com/s", title: "Same", engagement_score: 2 }),
      makeDraft({
        source: "rss",
        url: "https://example.com/s?x=1",
        title: "Same",
        engagement_score: 1,
      }),
    ]);
    const merged = mergeNearDuplicates(items);
    expect(merged.items).toHaveLength(1);
    expect(merged.items[0]?.merged_sources).toEqual([]);
    expect(merged.merged).toBe(1);
  });

  it("is a pure function of the input set: reordered feeds → same hashes", () => {
    const drafts = [
      makeDraft({
        source: "hackernews",
        url: "https://a.example.com/1",
        title: "Quantum batteries charge in nine seconds",
        engagement_score: 300,
      }),
      makeDraft({
        source: "reddit",
        url: "https://b.example.com/2",
        title: "Quantum batteries charge in nine seconds!!",
        engagement_score: 50,
      }),
      makeDraft({
        source: "github",
        url: "https://c.example.com/3",
        title: "Tiny ORM for embedded sqlite",
        engagement_score: 44,
      }),
      makeDraft({
        source: "wikipedia",
        url: "https://d.example.com/4",
        title: "Cat",
        engagement_score: 10,
      }),
      makeDraft({
        source: "rss",
        url: "https://e.example.com/5?utm_source=x",
        title: "Tiny ORM for embedded sqlite",
        engagement_score: 1,
      }),
    ];
    const orders = [
      [0, 1, 2, 3, 4],
      [4, 3, 2, 1, 0],
      [2, 4, 0, 3, 1],
    ];
    const hashSets = orders.map((order) => {
      const picked = order.map((i) => drafts[i]).filter((d) => d !== undefined);
      const { items } = normalizeDrafts(picked);
      return mergeNearDuplicates(items).items.map((m) => m.content_hash).sort();
    });
    expect(hashSets[1]).toEqual(hashSets[0]);
    expect(hashSets[2]).toEqual(hashSets[0]);
    // 5 inputs → 3 keepers: quantum pair, ORM pair (same title, different URLs), Cat.
    // (ORM pair shares the exact title → trigram Jaccard 1.)
    expect(hashSets[0]).toHaveLength(3);
  });

  it("transfers absorbed sources when a keeper is itself absorbed", () => {
    const { items } = normalizeDrafts([
      makeDraft({
        source: "hackernews",
        url: "https://shared.example.com/story",
        title: "Alpha release notes",
        engagement_score: 100,
      }),
      makeDraft({
        source: "reddit",
        url: "https://shared.example.com/story?utm_source=x",
        title: "Totally unrelated wording here",
        engagement_score: 10,
      }),
      makeDraft({
        source: "webpage",
        url: "https://other.example.com/notes",
        title: "Alpha release notes!!",
        engagement_score: 200,
      }),
    ]);
    const merged = mergeNearDuplicates(items);
    expect(merged.items).toHaveLength(1);
    expect(merged.items[0]?.source).toBe("webpage");
    expect(merged.items[0]?.merged_sources.slice().sort()).toEqual(["hackernews", "reddit"]);
    expect(merged.absorbed).toHaveLength(2);
  });
});

describe("cutoffDate", () => {
  it("subtracts days across month boundaries", () => {
    expect(cutoffDate("2026-09-30", 3)).toBe("2026-09-27");
    expect(cutoffDate("2026-03-01", 1)).toBe("2026-02-28");
    expect(cutoffDate("2026-09-30", 0)).toBe("2026-09-30");
  });
});

describe("seen_items", () => {
  it("drops hashes last seen on/after the cutoff, keeps older ones", () => {
    const db = openTestDb();
    try {
      recordSeenItems(
        db,
        [
          { content_hash: "old", source: "rss" },
          { content_hash: "edge", source: "rss" },
          { content_hash: "recent", source: "rss" },
        ],
        "2026-09-20",
      );
      // "edge" re-seen exactly on the cutoff → still dropped.
      recordSeenItems(db, [{ content_hash: "edge", source: "rss" }], "2026-09-27");
      recordSeenItems(db, [{ content_hash: "recent", source: "rss" }], "2026-09-29");
      const withHashes = ["old", "edge", "recent", "new"].map(itemWithHash);
      const { fresh, seenCount } = filterSeenItems(db, withHashes, {
        runDate: "2026-09-30",
        dedupeDays: 3, // cutoff 2026-09-27
      });
      expect(fresh.map((f) => f.content_hash).sort()).toEqual(["new", "old"]);
      expect(seenCount).toBe(2);
    } finally {
      db.close();
    }
  });

  it("dedupeDays ≤ 0 disables cross-day filtering", () => {
    const db = openTestDb();
    try {
      recordSeenItems(db, [{ content_hash: "x", source: "rss" }], "2026-09-30");
      const [item] = normalizeDrafts([makeDraft({ url: "https://example.com/x" })]).items;
      if (!item) throw new Error("normalize failed in test");
      const { fresh, seenCount } = filterSeenItems(db, [{ ...item, content_hash: "x" }], {
        runDate: "2026-09-30",
        dedupeDays: 0,
      });
      expect(fresh).toHaveLength(1);
      expect(seenCount).toBe(0);
    } finally {
      db.close();
    }
  });

  it("recordSeenItems upserts: first_seen preserved, last_seen advances", () => {
    const db = openTestDb();
    try {
      expect(recordSeenItems(db, [{ content_hash: "h", source: "rss" }], "2026-09-28")).toEqual({
        recorded: 1,
      });
      expect(recordSeenItems(db, [{ content_hash: "h", source: "github" }], "2026-09-30")).toEqual({
        recorded: 1, // input-deduped, still one logical entry
      });
      const row = db
        .prepare("SELECT first_seen_date, last_seen_date, source FROM seen_items WHERE content_hash = ?")
        .get("h") as { first_seen_date: string; last_seen_date: string; source: string };
      expect(row.first_seen_date).toBe("2026-09-28");
      expect(row.last_seen_date).toBe("2026-09-30");
      expect(row.source).toBe("rss"); // original reporter kept
    } finally {
      db.close();
    }
  });
});
