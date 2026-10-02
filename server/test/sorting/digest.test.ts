import { describe, expect, it } from "vitest";
import { LlmValidationError } from "../../src/llm/client.js";
import {
  countSentences,
  DIGEST_MAX_SENTENCES,
  DIGEST_MIN_SENTENCES,
  DIGEST_TOPIC_LIMIT,
  formatDigestInput,
  generateDigest,
} from "../../src/sorting/digest.js";
import { StubJevClient } from "./helpers.js";

function topics(n: number): { title: string; summary: string }[] {
  return Array.from({ length: n }, (_, i) => ({
    title: `Topic ${String(i)}`,
    summary: `Summary ${String(i)}.`,
  }));
}

describe("countSentences", () => {
  it("counts terminal punctuation runs", () => {
    expect(countSentences("One. Two! Three?")).toBe(3);
    expect(countSentences("")).toBe(0);
    expect(countSentences("No terminator")).toBe(1);
  });

  it("bounds are 3–5 sentences over the top 10 topics", () => {
    expect(DIGEST_MIN_SENTENCES).toBe(3);
    expect(DIGEST_MAX_SENTENCES).toBe(5);
    expect(DIGEST_TOPIC_LIMIT).toBe(10);
  });
});

describe("generateDigest", () => {
  it("sends at most the top 10 topics and accepts 3–5 sentences", async () => {
    const client = new StubJevClient((_tag, user) => {
      expect(user).toContain("Topic 0");
      expect(user).toContain("Topic 9");
      expect(user).not.toContain("Topic 10");
      return { digest: "One. Two. Three. Four." };
    });
    const result = await generateDigest(client, topics(12));
    expect(result.digest).toBe("One. Two. Three. Four.");
    expect(result.repaired).toBe(false);
    expect(result.model).toBe("stub-jev");
    expect(client.callsTo("jev_digest")).toHaveLength(1);
  });

  it("repairs a sentence-count violation once with an explicit rewrite", async () => {
    let calls = 0;
    const client = new StubJevClient((_tag, user) => {
      calls += 1;
      if (calls === 1) {
        expect(user).toContain("TOPICS:");
        return { digest: "One. Two. Three. Four. Five. Six." };
      }
      expect(user).toContain("Rewrite");
      expect(user).toContain("exactly 4 sentences");
      return { digest: "One. Two. Three. Four." };
    });
    const result = await generateDigest(client, topics(3));
    expect(result.digest).toBe("One. Two. Three. Four.");
    expect(result.repaired).toBe(true);
  });

  it("throws LlmValidationError when the rewrite still violates the range", async () => {
    const client = new StubJevClient(() => ({ digest: "One. Two." }));
    await expect(generateDigest(client, topics(3))).rejects.toBeInstanceOf(LlmValidationError);
  });

  it("formats the digest input as a topic list", () => {
    expect(formatDigestInput([{ title: "T", summary: "S" }])).toBe("TOPICS:\n- T: S");
  });
});
