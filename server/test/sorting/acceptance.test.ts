import { describe, expect, it } from "vitest";
import { mapAllBatches } from "../../src/sorting/map.js";
import type { JevTopic } from "../../src/sorting/map.js";
import { reduceTopics } from "../../src/sorting/reduce.js";
import { scoreTopics } from "../../src/sorting/score.js";
import type { SortedTrendRecord } from "../../src/sheets/schema.js";
import type { RawTrendRecord } from "../../src/sheets/schema.js";
import {
  makeRawItem,
  mapInputIds,
  reduceInputIdGroups,
  StubJevClient,
} from "./helpers.js";

const CATEGORIES = ["Tech", "AI", "Business", "Science", "Health"] as const;
const MOMENTUMS = ["new", "rising", "peak", "steady", "fading"] as const;
const SOURCES = ["hackernews", "reddit", "github", "wikipedia", "rss"] as const;

function buildItems(count: number): RawTrendRecord[] {
  return Array.from({ length: count }, (_, i) =>
    makeRawItem({
      source: SOURCES[i % SOURCES.length] ?? "hackernews",
      url: `https://acc.example.com/${String(i)}`,
      title: `Acceptance story ${String(i)} about topic ${String(i % 7)}`,
      snippet: `Snippet for story ${String(i)}.`,
      engagement_score: i,
      engagement_norm: (i % 10) / 10,
    }),
  );
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

function mapHandler(_tag: string, user: string): unknown {
  const ids = mapInputIds(user);
  return {
    topics: chunk(ids, 10).map(
      (group, gi): JevTopic => ({
        title: `Batch topic ${String(gi)}`,
        summary: `Summary for batch topic ${String(gi)}.`,
        category: CATEGORIES[gi % CATEGORIES.length] ?? "Tech",
        tags: [`t${String(gi)}`],
        relevance: (50 + gi * 3) % 101,
        novelty: (40 + gi * 7) % 101,
        momentum: MOMENTUMS[gi % MOMENTUMS.length] ?? "new",
        sentiment: "neutral",
        why_trending: "Coverage is converging.",
        content_angles: ["Angle one", "Angle two", "Angle three"],
        item_ids: group,
      }),
    ),
  };
}

function reduceHandler(_tag: string, user: string): unknown {
  const ids = reduceInputIdGroups(user).flat();
  return {
    topics: chunk(ids, 20).map(
      (group, ci): JevTopic => ({
        title: `Merged topic ${String(ci)}`,
        summary: `Merged summary ${String(ci)}.`,
        category: CATEGORIES[ci % CATEGORIES.length] ?? "Tech",
        tags: [`m${String(ci)}`],
        relevance: (60 + ci * 5) % 101,
        novelty: (30 + ci * 11) % 101,
        momentum: "rising",
        sentiment: "neutral",
        why_trending: "Cross-batch merge.",
        content_angles: ["Recap", "Deep dive", "Takeaways"],
        item_ids: group,
      }),
    ),
  };
}

async function runSort(
  items: RawTrendRecord[],
  client: StubJevClient,
): Promise<SortedTrendRecord[]> {
  const mapped = await mapAllBatches({
    client,
    items,
    niches: ["ai"],
    runDate: "2026-09-30",
    batchSize: 30,
    concurrency: 2,
  });
  expect(mapped.failedItemIds).toEqual([]);
  expect(mapped.batchCount).toBe(4); // 100 items / 30 → 30/30/30/10
  const reduced = await reduceTopics({
    client,
    topics: mapped.topics,
    knownItemIds: new Set(items.map((item) => item.id)),
    batchCount: mapped.batchCount,
  });
  const scored = scoreTopics({
    topics: reduced.topics,
    itemsById: new Map(items.map((item) => [item.id, item])),
    runId: "run-acc",
    runDate: "2026-09-30",
    jevModel: "stub-jev",
    topN: 50,
    firstSeenDates: new Map(items.map((item) => [item.id, "2026-09-30"])),
    now: "2026-09-30T07:00:00.000Z",
  });
  return scored.topics;
}

function stableForm(topics: SortedTrendRecord[]): object[] {
  return topics.map((t) => ({
    rank: t.rank,
    title: t.title,
    trend_score: t.trend_score,
    evidence: [...t.evidence_item_ids].sort(),
    momentum: t.momentum,
  }));
}

/** Route jev_map → mapHandler, jev_reduce → reduceHandler. */
function mapHandlerBridge(tag: string, user: string): unknown {
  if (tag === "jev_reduce") return reduceHandler(tag, user);
  return mapHandler(tag, user);
}

describe("phase 5 acceptance: 100 mixed items", () => {
  it("≤ N topics, valid evidence, one topic per item, scores 0–100, deterministic", async () => {
    const items = buildItems(100);
    const inputIds = items.map((item) => item.id).sort();

    const first = await runSort(items, new StubJevClient(mapHandlerBridge));
    expect(first.length).toBeGreaterThan(0);
    expect(first.length).toBeLessThanOrEqual(50);

    const evidence = first.flatMap((t) => t.evidence_item_ids);
    expect([...evidence].sort()).toEqual(inputIds); // every item exactly once
    for (const topic of first) {
      expect(topic.trend_score).toBeGreaterThanOrEqual(0);
      expect(topic.trend_score).toBeLessThanOrEqual(100);
      expect(Number.isInteger(topic.trend_score)).toBe(true);
    }
    expect(first.map((t) => t.rank)).toEqual(first.map((_, i) => i + 1));

    const second = await runSort(items, new StubJevClient(mapHandlerBridge));
    expect(stableForm(second)).toEqual(stableForm(first));
  });

  it("maps in 4 batches then reduces once", async () => {
    const client = new StubJevClient(mapHandlerBridge);
    await runSort(buildItems(100), client);
    expect(client.callsTo("jev_map")).toHaveLength(4);
    expect(client.callsTo("jev_reduce")).toHaveLength(1);
  });
});
