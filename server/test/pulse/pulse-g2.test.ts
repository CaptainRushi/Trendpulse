import { describe, expect, it } from "vitest";
import { applyMigrations, openDatabase } from "../../src/db/sqlite.js";
import type { StateDb } from "../../src/db/sqlite.js";
import { HttpClient, type EtagCacheStore } from "../../src/collectors/http.js";
import { buildRefreshers, sqliteEtagStore } from "../../src/pulse/refreshers.js";
import { PulseSampler } from "../../src/pulse/sampler.js";
import { writeLatestSet } from "../../src/pulse/index.js";
import type { PulseConfig } from "../../src/pulse/config.js";
import type { RefreshItem } from "../../src/pulse/refresh.js";
import { fixture } from "../collectors/helpers.js";
import type { IndexableTopic } from "../../src/pulse/index.js";

const CONFIG: PulseConfig = { enabled: true, intervalMin: 20, topN: 5, maxRequests: 30, retentionDays: 14 };

function mapStore(): EtagCacheStore {
  const etags = new Map<string, { etag: string | null; last_modified: string | null }>();
  return {
    get: (url: string) => Promise.resolve(etags.get(url) ?? null),
    set: (url: string, etag: string | null, lastModified: string | null) => {
      etags.set(url, { etag, last_modified: lastModified });
      return Promise.resolve();
    },
  };
}

function hnItem(id: string, sourceItemId = "", baseline = 100): RefreshItem {
  return { itemId: id, source: "hackernews", url: `https://news.ycombinator.com/item?id=${id}`, sourceItemId, baseline, lastValue: baseline };
}

function ghItem(id: string, repo: string, baseline = 90000): RefreshItem {
  return { itemId: id, source: "github", url: `https://github.com/${repo}`, sourceItemId: "", baseline, lastValue: baseline };
}

describe("PULSE-10 hackernews fixture", () => {
  it("reads score from the real item shape", async () => {
    const http = new HttpClient({
      userAgent: "test",
      maxAttempts: 1,
      fetchImpl: () => Promise.resolve(new Response(fixture("pulse/hn_item_8863.json"), { status: 200 })),
    });
    const [hn] = buildRefreshers({ http });
    const out = await hn?.refresh([hnItem("8863", "8863")]);
    expect(out).toEqual([{ itemId: "8863", value: 104 }]);
  });

  it("dead items count as failed (carry-forward upstream)", async () => {
    const http = new HttpClient({
      userAgent: "test",
      maxAttempts: 1,
      fetchImpl: () => Promise.resolve(new Response(JSON.stringify({ id: 1, dead: true }), { status: 200 })),
    });
    const [hn] = buildRefreshers({ http });
    const out = await hn?.refresh([hnItem("1", "1")]);
    expect(out?.[0]?.error).toBe("dead");
    expect(out?.[0]?.value).toBeUndefined();
  });
});

describe("PULSE-11 github fixture with 304", () => {
  it("stars first, unchanged on ETag revalidation", async () => {
    let second = false;
    const http = new HttpClient({
      userAgent: "test",
      maxAttempts: 1,
      cache: mapStore(),
      fetchImpl: () => {
        if (!second) {
          second = true;
          return Promise.resolve(
            new Response(fixture("pulse/github_repo.json"), { status: 200, headers: { ETag: '"abc123"' } }),
          );
        }
        return Promise.resolve(new Response(null, { status: 304 }));
      },
    });
    const refreshers = buildRefreshers({ http });
    const gh = refreshers.find((r) => r.source === "github");
    const first = await gh?.refresh([ghItem("g1", "Panniantong/agent-reach")]);
    expect(first?.[0]?.value).toBe(90222);
    const revalidated = await gh?.refresh([ghItem("g1", "Panniantong/agent-reach")]);
    expect(revalidated?.[0]?.unchanged).toBe(true);
  });
});

describe("PULSE-12 unknown source skipped", () => {
  it("webpage items get 'no live metric' with zero requests", async () => {
    const db: StateDb = openDatabase(":memory:");
    applyMigrations(db);
    try {
      db.prepare("INSERT INTO runs (id, run_date, trigger, status, stages_requested, started_at) VALUES ('run_1','2026-10-04','manual','success','[]','2026-10-04T06:00:00.000Z')").run();
      db.prepare("INSERT INTO items_run (id, run_id, run_date, source, content_hash, payload_json) VALUES ('w','run_1','2026-10-04','webpage','h-w',?)").run(
        JSON.stringify({ url: "https://example.com/p", engagement_score: 2 }),
      );
      // webpage is not refreshable: no baseline, no series, topic skipped.
      const topics: IndexableTopic[] = [
        { topic_id: "t1", rank: 1, title: "T", trend_score: 80, source_count: 1, hidden: false, evidence_item_ids: ["w"] },
      ];
      const written = writeLatestSet(db, "run_1", "2026-10-04", topics, 5, "2026-10-04T06:00:00.000Z");
      expect(written.baselined).toBe(0);
      const http = new HttpClient({ userAgent: "test", maxAttempts: 1 });
      const sampler = new PulseSampler({
        db,
        config: CONFIG,
        refreshers: buildRefreshers({ http }),
        isPipelineActive: () => false,
        emit: () => undefined,
        today: () => "2026-10-04",
        nowIso: () => "2026-10-04T12:00:00.000Z",
      });
      const result = await sampler.runCycle("manual");
      expect(result.requests).toBe(0);
      expect(result.skipped).toBe(1);
    } finally {
      db.close();
    }
  });
});

describe("PULSE-13 reddit skipped without OAuth", () => {
  it("reports the reason instead of calling the network", async () => {
    let calls = 0;
    const http = new HttpClient({
      userAgent: "test",
      maxAttempts: 1,
      fetchImpl: () => {
        calls += 1;
        return Promise.resolve(new Response("{}", { status: 200 }));
      },
    });
    const reddit = buildRefreshers({ http }).find((r) => r.source === "reddit");
    const out = await reddit?.refresh([
      { itemId: "r1", source: "reddit", url: "https://reddit.com/x", sourceItemId: "", baseline: 5, lastValue: 5 },
    ]);
    expect(out).toEqual([{ itemId: "r1", skipped: "reddit needs OAuth" }]);
    expect(calls).toBe(0);
  });
});

describe("PULSE-14 dead item keeps last value and counts failed", () => {
  it("cycle stores a point from carry-forward with items_failed 1", async () => {
    const db: StateDb = openDatabase(":memory:");
    applyMigrations(db);
    try {
      db.prepare("INSERT INTO runs (id, run_date, trigger, status, stages_requested, started_at) VALUES ('run_1','2026-10-04','manual','success','[]','2026-10-04T06:00:00.000Z')").run();
      db.prepare("INSERT INTO items_run (id, run_id, run_date, source, content_hash, payload_json) VALUES ('a','run_1','2026-10-04','hackernews','h-a',?)").run(
        JSON.stringify({ url: "https://news.ycombinator.com/item?id=9", engagement_score: 50, source_item_id: "9" }),
      );
      db.prepare("INSERT INTO items_run (id, run_id, run_date, source, content_hash, payload_json) VALUES ('b','run_1','2026-10-04','hackernews','h-b',?)").run(
        JSON.stringify({ url: "https://news.ycombinator.com/item?id=8863", engagement_score: 50, source_item_id: "8863" }),
      );
      const topics: IndexableTopic[] = [
        { topic_id: "t1", rank: 1, title: "T", trend_score: 80, source_count: 1, hidden: false, evidence_item_ids: ["a", "b"] },
      ];
      writeLatestSet(db, "run_1", "2026-10-04", topics, 5, "2026-10-04T06:00:00.000Z");
      const http = new HttpClient({
        userAgent: "test",
        maxAttempts: 1,
        fetchImpl: (input: RequestInfo | URL) => {
          const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
          if (url.includes("item/9.json")) return Promise.resolve(new Response(JSON.stringify({ id: 9, deleted: true }), { status: 200 }));
          return Promise.resolve(new Response(fixture("pulse/hn_item_8863.json"), { status: 200 }));
        },
      });
      const sampler = new PulseSampler({
        db,
        config: CONFIG,
        refreshers: buildRefreshers({ http }),
        isPipelineActive: () => false,
        emit: () => undefined,
        today: () => "2026-10-04",
        nowIso: () => "2026-10-04T12:00:00.000Z",
      });
      const result = await sampler.runCycle("manual");
      expect(result.sampled).toBe(1);
      const row = db.prepare("SELECT index_value, items_failed FROM topic_samples WHERE topic_id = 't1' ORDER BY sampled_at DESC LIMIT 1").get() as {
        index_value: number;
        items_failed: number;
      };
      expect(row.items_failed).toBe(1);
      expect(row.index_value).toBe(154); // 100 * (104 + carried 50) / 100
    } finally {
      db.close();
    }
  });
});

describe("sqlite etag store", () => {
  it("round-trips through http_cache", async () => {
    const db: StateDb = openDatabase(":memory:");
    applyMigrations(db);
    try {
      const store = sqliteEtagStore(db);
      expect(await store.get("https://x")).toBeNull();
      await store.set("https://x", '"e1"', null);
      expect(await store.get("https://x")).toEqual({ etag: '"e1"', last_modified: null });
    } finally {
      db.close();
    }
  });
});
