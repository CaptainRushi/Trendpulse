import { describe, expect, it } from "vitest";
import { scoreTopics } from "../../src/sorting/score.js";
import { DEFAULT_SCORE_WEIGHTS } from "../../src/sorting/score.js";
import type { JevTopic } from "../../src/sorting/score.js";
import type { RawTrendRecord } from "../../src/sheets/schema.js";
import { makeRawItem } from "./helpers.js";

const RUN = { runId: "run-1", runDate: "2026-09-30", jevModel: "stub-jev" };

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

/** Golden fixture: hand-computed TRD §7 scores (see comments). */
function goldenFixture(): { topics: JevTopic[]; itemsById: Map<string, RawTrendRecord> } {
  const a1 = makeRawItem({
    source: "hackernews",
    url: "https://a.example.com/1",
    engagement_norm: 1.0,
  });
  const a2 = makeRawItem({
    source: "reddit",
    url: "https://b.example.com/2",
    engagement_norm: 0.5,
  });
  const b1 = makeRawItem({
    source: "github",
    url: "https://c.example.com/3",
    engagement_norm: 0.0,
  });
  const topics = [
    topic({
      title: "Alpha",
      summary: "Alpha summary.",
      relevance: 80,
      novelty: 60,
      momentum: "rising",
      item_ids: [a1.id, a2.id],
    }),
    topic({
      title: "Beta",
      summary: "Beta summary.",
      category: "AI",
      relevance: 100,
      novelty: 100,
      momentum: "peak", // all evidence new today → coerced to "new"
      item_ids: [b1.id],
    }),
  ];
  return { topics, itemsById: new Map([[a1.id, a1], [a2.id, a2], [b1.id, b1]]) };
}

describe("scoreTopics golden", () => {
  it("computes the TRD §7 formula exactly", () => {
    const { topics, itemsById } = goldenFixture();
    const firstSeenDates = new Map([...itemsById.keys()].map((id) => [id, "2026-09-30"] as const));
    const result = scoreTopics({ ...RUN, topics, itemsById, firstSeenDates });

    // Alpha: E = 1.0*0.7 + 0.75*0.3 = 0.925; S = 2/4 = 0.5; R = 0.8; N = 0.6
    //   100*(0.35*0.925 + 0.25*0.5 + 0.25*0.8 + 0.15*0.6) = 73.875 → 74
    // Beta:  E = 0; S = 1/4 = 0.25; R = 1; N = 1
    //   100*(0 + 0.0625 + 0.25 + 0.15) = 46.25 → 46
    expect(result.topics.map((t) => [t.title, t.trend_score, t.rank])).toEqual([
      ["Alpha", 74, 1],
      ["Beta", 46, 2],
    ]);
    const alpha = result.topics[0];
    expect(alpha?.score_engagement).toBeCloseTo(0.925, 10);
    expect(alpha?.score_diversity).toBe(0.5);
    expect(alpha?.score_relevance).toBe(0.8);
    expect(alpha?.score_novelty).toBe(0.6);
    expect(alpha?.source_count).toBe(2);
    expect(alpha?.top_urls).toEqual(["https://a.example.com/1", "https://b.example.com/2"]);
    expect(alpha?.prompt_version).toBe("v1");
    expect(alpha?.is_latest).toBe(true);
    expect(alpha?.hidden).toBe(false);
  });

  it("coerces impossible momentum (all evidence new today) to new", () => {
    const { topics, itemsById } = goldenFixture();
    const firstSeenDates = new Map([...itemsById.keys()].map((id) => [id, "2026-09-30"] as const));
    const result = scoreTopics({ ...RUN, topics, itemsById, firstSeenDates });
    expect(result.topics.find((t) => t.title === "Beta")?.momentum).toBe("new");
    expect(result.momentumCoerced).toBe(1);
  });

  it("keeps momentum with mixed or unknown first-seen dates", () => {
    const { topics, itemsById } = goldenFixture();
    const mixed = new Map([
      [topics[0]?.item_ids[0] ?? "", "2026-09-30"],
      [topics[0]?.item_ids[1] ?? "", "2026-09-28"],
      [topics[1]?.item_ids[0] ?? "", "2026-09-28"],
    ]);
    const kept = scoreTopics({ ...RUN, topics, itemsById, firstSeenDates: mixed });
    expect(kept.topics.find((t) => t.title === "Beta")?.momentum).toBe("peak");
    expect(kept.momentumCoerced).toBe(0);

    const unknown = scoreTopics({ ...RUN, topics, itemsById });
    expect(unknown.topics.find((t) => t.title === "Beta")?.momentum).toBe("peak");
  });

  it("honors custom weights", () => {
    const { topics, itemsById } = goldenFixture();
    const result = scoreTopics({
      ...RUN,
      topics,
      itemsById,
      weights: { ...DEFAULT_SCORE_WEIGHTS, engagement: 1, diversity: 0, relevance: 0, novelty: 0 },
    });
    // Alpha E=0.925 → 93 (Math.round(92.5)); Beta E=0 → 0.
    expect(result.topics.map((t) => [t.title, t.trend_score])).toEqual([
      ["Alpha", 93],
      ["Beta", 0],
    ]);
  });

  it("drops topics with no resolvable evidence", () => {
    const { topics, itemsById } = goldenFixture();
    const result = scoreTopics({
      ...RUN,
      topics: [...topics, topic({ title: "Ghost", item_ids: ["nope"] })],
      itemsById,
    });
    expect(result.droppedNoEvidence).toBe(1);
    expect(result.topics.map((t) => t.title)).toEqual(["Alpha", "Beta"]);
  });

  it("returns all ranked with sequential ranks (no global cut)", () => {
    const { topics, itemsById } = goldenFixture();
    const extra = topic({ title: "Gamma", relevance: 10, novelty: 10, item_ids: [topics[0]?.item_ids[0] ?? ""] });
    const result = scoreTopics({ ...RUN, topics: [...topics, extra], itemsById });
    expect(result.topics).toHaveLength(3);
    expect(result.topics.map((t) => t.rank)).toEqual([1, 2, 3]);
  });

  it("ranks deterministically for fixed input (ids/timestamps excluded)", () => {
    const { topics, itemsById } = goldenFixture();
    const firstSeen = new Map([...itemsById.keys()].map((id) => [id, "2026-09-30"] as const));
    const run = (): object[] =>
      scoreTopics({ ...RUN, topics, itemsById, firstSeenDates: firstSeen }).topics.map((t) => ({
        rank: t.rank,
        title: t.title,
        trend_score: t.trend_score,
        evidence: t.evidence_item_ids,
        momentum: t.momentum,
      }));
    expect(run()).toEqual(run());
  });
});
