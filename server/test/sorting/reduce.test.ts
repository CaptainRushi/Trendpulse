import { describe, expect, it } from "vitest";
import { LlmHttpError, LlmValidationError } from "../../src/llm/client.js";
import { formatReduceInput, reduceTopics } from "../../src/sorting/reduce.js";
import type { JevTopic } from "../../src/sorting/map.js";
import { makeRawItem, StubJevClient } from "./helpers.js";

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

describe("formatReduceInput", () => {
  it("lists titles, summaries and item ids", () => {
    const user = formatReduceInput([topic({ title: "T", summary: "S", item_ids: ["a", "b"] })]);
    expect(user).toContain("TOPICS:");
    expect(user).toContain("T || S || items: a,b");
  });
});

describe("reduceTopics", () => {
  it("skips the LLM call for a single batch (reduced: false, no call)", async () => {
    const items = [makeRawItem(), makeRawItem()];
    const client = new StubJevClient(() => ({ topics: [], discarded: [] }));
    const result = await reduceTopics({
      client,
      topics: [topic({ item_ids: items.map((i) => i.id) })],
      knownItemIds: new Set(items.map((i) => i.id)),
      batchCount: 1,
    });
    expect(result.reduced).toBe(false);
    expect(result.topics).toHaveLength(1);
    expect(client.calls).toHaveLength(0);
  });

  it("merges across batches and sanitizes the reply", async () => {
    const ids = ["a", "b", "c", "d"];
    const client = new StubJevClient((_tag, user) => {
      expect(user).toContain("TOPICS:");
      return {
        topics: [
          topic({ title: "Merged", item_ids: ["a", "b", "ghost"] }),
          topic({ title: "Kept", item_ids: ["c", "a"] }),
        ],
      };
    });
    const result = await reduceTopics({
      client,
      topics: [
        topic({ title: "T1", item_ids: ["a", "b"] }),
        topic({ title: "T2", item_ids: ["c", "d"] }),
      ],
      knownItemIds: new Set(ids),
      batchCount: 2,
    });
    expect(result.reduced).toBe(true);
    expect(result.topics.map((t) => t.item_ids)).toEqual([
      ["a", "b"],
      ["c"],
    ]);
    expect(result.droppedUnknownIds).toBe(1);
    expect(result.duplicateClaims).toBe(1);
    expect(client.callsTo("jev_reduce")).toHaveLength(1);
  });

  it("falls back to concatenated map topics when reduce output stays invalid", async () => {
    const ids = ["a", "b"];
    const client = new StubJevClient(() => {
      throw new LlmValidationError("reduce bad");
    });
    const result = await reduceTopics({
      client,
      topics: [topic({ title: "T1", item_ids: ["a", "ghost"] })],
      knownItemIds: new Set(ids),
      batchCount: 2,
    });
    expect(result.reduced).toBe(false);
    expect(result.topics.map((t) => t.item_ids)).toEqual([["a"]]);
    expect(result.droppedUnknownIds).toBe(1);
  });

  it("propagates non-validation errors", async () => {
    const client = new StubJevClient(() => {
      throw new LlmHttpError("boom", { status: 500 });
    });
    await expect(
      reduceTopics({
        client,
        topics: [topic({ item_ids: ["a"] })],
        knownItemIds: new Set(["a"]),
        batchCount: 2,
      }),
    ).rejects.toBeInstanceOf(LlmHttpError);
  });
});
