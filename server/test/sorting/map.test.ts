import { describe, expect, it } from "vitest";
import { LlmHttpError, LlmValidationError } from "../../src/llm/client.js";
import {
  formatMapInput,
  mapAllBatches,
  sanitizeDiscarded,
  sanitizeMapTopics,
} from "../../src/sorting/map.js";
import type { JevTopic } from "../../src/sorting/map.js";
import { makeRawItem, mapInputIds, StubJevClient } from "./helpers.js";

function topic(overrides: Partial<JevTopic> & { item_ids: string[] }): JevTopic {
  return {
    title: "Topic",
    summary: "Summary of the topic.",
    category: "Tech",
    tags: ["ai"],
    relevance: 50,
    novelty: 50,
    momentum: "rising",
    sentiment: "neutral",
    why_trending: "Why it trends.",
    content_angles: ["Angle one", "Angle two", "Angle three"],
    ...overrides,
  };
}

describe("sanitizeMapTopics", () => {
  it("drops unknown ids, emptied topics, and second claims (first wins)", () => {
    const result = sanitizeMapTopics(
      [
        topic({ item_ids: ["a", "ghost"] }),
        topic({ title: "Second", item_ids: ["a", "b"] }),
        topic({ title: "Empty", item_ids: ["ghost"] }),
      ],
      new Set(["a", "b"]),
    );
    expect(result.topics.map((t) => [t.title, t.item_ids])).toEqual([
      ["Topic", ["a"]],
      ["Second", ["b"]],
    ]);
    expect(result.droppedUnknownIds).toBe(2); // ghost × 2
    expect(result.duplicateClaims).toBe(1); // "a" claimed twice
  });

  it("filters discarded entries to known items", () => {
    const result = sanitizeDiscarded(
      [
        { item_id: "a", reason: "spam" },
        { item_id: "ghost", reason: "spam" },
      ],
      new Set(["a"]),
    );
    expect(result.discarded).toEqual([{ item_id: "a", reason: "spam" }]);
    expect(result.droppedUnknownIds).toBe(1);
  });
});

describe("formatMapInput", () => {
  it("follows the TRD §8.2 user format", () => {
    const items = [makeRawItem({ title: "T", snippet: "S" })];
    const user = formatMapInput(items, ["ai", "tech"], "2026-09-30");
    expect(user).toContain("NICHES: ai, tech");
    expect(user).toContain("DATE: 2026-09-30");
    expect(user).toContain("ITEMS:");
    expect(user).toContain(`[${items[0]?.id ?? ""}] hackernews | T | S |`);
  });
});

describe("mapAllBatches", () => {
  it("sanitizes a batch reply (unknown ids, dup claims, bad discards)", async () => {
    const items = [makeRawItem(), makeRawItem(), makeRawItem()];
    const ids = items.map((item) => item.id);
    const client = new StubJevClient(() => ({
      topics: [
        topic({ item_ids: [ids[0] ?? "", "ghost"] }),
        topic({ title: "Dup", item_ids: [ids[0] ?? "", ids[1] ?? ""] }),
      ],
      discarded: [
        { item_id: ids[2] ?? "", reason: "ad" },
        { item_id: "ghost", reason: "ad" },
      ],
    }));
    const result = await mapAllBatches({
      client,
      items,
      niches: [],
      runDate: "2026-09-30",
      batchSize: 30,
    });
    expect(result.topics.map((t) => t.item_ids)).toEqual([[ids[0]], [ids[1]]]);
    expect(result.discarded).toEqual([{ item_id: ids[2], reason: "ad" }]);
    expect(result.droppedUnknownIds).toBe(2);
    expect(result.duplicateClaims).toBe(1);
    expect(result.failedItemIds).toEqual([]);
    expect(result.batchCount).toBe(1);
  });

  it("splits a failed batch in half once (ladder)", async () => {
    const items = [makeRawItem(), makeRawItem(), makeRawItem(), makeRawItem()];
    let calls = 0;
    const client = new StubJevClient((_tag, user) => {
      calls += 1;
      if (calls === 1) throw new LlmValidationError("whole batch bad");
      const ids = mapInputIds(user);
      return { topics: [topic({ title: `Half of ${String(ids.length)}`, item_ids: ids })] };
    });
    const result = await mapAllBatches({
      client,
      items,
      niches: [],
      runDate: "2026-09-30",
      batchSize: 30,
    });
    expect(result.topics).toHaveLength(2);
    expect(result.failedItemIds).toEqual([]);
    expect(calls).toBe(3); // whole + 2 halves
  });

  it("marks halves that still fail as sort_failed", async () => {
    const items = [makeRawItem(), makeRawItem()];
    const client = new StubJevClient(() => {
      throw new LlmValidationError("always bad");
    });
    const result = await mapAllBatches({
      client,
      items,
      niches: [],
      runDate: "2026-09-30",
      batchSize: 30,
    });
    expect(result.topics).toEqual([]);
    expect(result.failedItemIds).toEqual(items.map((item) => item.id));
  });

  it("fails a single-item batch directly (nothing to split)", async () => {
    const items = [makeRawItem()];
    const client = new StubJevClient(() => {
      throw new LlmValidationError("bad");
    });
    const result = await mapAllBatches({
      client,
      items,
      niches: [],
      runDate: "2026-09-30",
      batchSize: 30,
    });
    expect(result.failedItemIds).toEqual(items.map((item) => item.id));
  });

  it("propagates non-validation errors (network, timeout)", async () => {
    const client = new StubJevClient(() => {
      throw new LlmHttpError("boom", { status: 500 });
    });
    await expect(
      mapAllBatches({ client, items: [makeRawItem()], niches: [], runDate: "2026-09-30" }),
    ).rejects.toBeInstanceOf(LlmHttpError);
  });

  it("chunks into batchSize pieces, order-preserving", async () => {
    const items = Array.from({ length: 65 }, () => makeRawItem());
    const client = new StubJevClient(() => ({ topics: [], discarded: [] }));
    const result = await mapAllBatches({
      client,
      items,
      niches: [],
      runDate: "2026-09-30",
      batchSize: 30,
    });
    expect(result.batchCount).toBe(3);
    expect(result.batches).toHaveLength(3);
    expect(client.callsTo("jev_map")).toHaveLength(3);
  });
});
