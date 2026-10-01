import { describe, expect, it } from "vitest";
import {
  applyEngagementNorm,
  cleanText,
  detectLanguage,
  MAX_SNIPPET_LENGTH,
  MAX_TITLE_LENGTH,
  normalizeDrafts,
} from "../../src/pipeline/normalize.js";
import { makeDraft } from "./helpers.js";

describe("cleanText", () => {
  it("strips tags, decodes entities, collapses whitespace", () => {
    expect(cleanText("<p>Hello &amp; <b>world</b></p>")).toBe("Hello & world");
    expect(cleanText("it&#39;s&nbsp;here")).toBe("it's here");
    expect(cleanText("  too   much\n\tspace  ")).toBe("too much space");
    expect(cleanText("&#x41;BC")).toBe("ABC");
    expect(cleanText("&bogus; stays")).toBe("&bogus; stays");
  });
});

describe("normalizeDrafts", () => {
  it("trims and caps title/snippet per backend schema §3", () => {
    const { items } = normalizeDrafts([
      makeDraft({ title: `  ${"T".repeat(400)}  `, snippet: ` ${"S".repeat(900)} ` }),
    ]);
    expect(items).toHaveLength(1);
    expect(items[0]?.title).toHaveLength(MAX_TITLE_LENGTH);
    expect(items[0]?.title).toBe("T".repeat(MAX_TITLE_LENGTH));
    expect(items[0]?.snippet).toHaveLength(MAX_SNIPPET_LENGTH);
  });

  it("canonicalizes URLs (utm stripped) and hashes the canonical form", () => {
    const { items } = normalizeDrafts([
      makeDraft({ url: "https://Example.com/Story?utm_source=x&fbclid=abc&id=7#frag" }),
    ]);
    expect(items[0]?.url).toBe("https://example.com/Story?id=7");
  });

  it("drops non-http URLs and empty-after-clean titles with counts", () => {
    const result = normalizeDrafts([
      makeDraft({ url: "javascript:alert(1)" }),
      makeDraft({ url: "ftp://example.com/x" }),
      makeDraft({ title: "<p>   </p>" }),
      makeDraft({ title: "Kept", url: "https://example.com/kept" }),
    ]);
    expect(result.stats).toMatchObject({
      input: 4,
      output: 1,
      droppedBadUrl: 2,
      droppedEmptyTitle: 1,
    });
    expect(result.items[0]?.title).toBe("Kept");
  });

  it("keeps valid ISO dates, nulls the unparseable (never throws)", () => {
    // RawItemDraft's zod type already rejects garbage dates, so the invalid
    // case is injected past the type boundary: normalize must still not throw.
    const invalid = { ...makeDraft({ url: "https://example.com/b" }), published_at: "not a date" };
    const { items } = normalizeDrafts([
      makeDraft({ published_at: "2026-09-30T12:00:00Z" }),
      invalid,
      makeDraft({ published_at: null, url: "https://example.com/c" }),
    ]);
    expect(items[0]?.published_at).toBe("2026-09-30T12:00:00.000Z");
    expect(items[1]?.published_at).toBeNull();
    expect(items[2]?.published_at).toBeNull();
  });

  it("normalizes blank author/region to null", () => {
    const { items } = normalizeDrafts([
      makeDraft({ author: "  ", region: "" }),
      makeDraft({ author: " Ada ", region: " EU ", url: "https://example.com/b" }),
    ]);
    expect(items[0]?.author).toBeNull();
    expect(items[0]?.region).toBeNull();
    expect(items[1]?.author).toBe("Ada");
    expect(items[1]?.region).toBe("EU");
  });
});

describe("detectLanguage", () => {
  it("keeps a valid provided ISO 639-1 code (case-insensitive)", () => {
    expect(detectLanguage("EN", "Hello world", "")).toBe("en");
    expect(detectLanguage("fr", "Hello world", "")).toBe("fr");
  });

  it("falls back to heuristics for invalid provided codes", () => {
    expect(detectLanguage("english", "The cat sat on the mat", "")).toBe("en");
    expect(detectLanguage(null, "The cat sat on the mat", "")).toBe("en");
  });

  it("detects scripts: Cyrillic, Arabic, Japanese kana", () => {
    expect(detectLanguage(null, "Президент подписал новый закон", "")).toBe("ru");
    expect(detectLanguage(null, "الحكومة تعلن عن قانون جديد", "")).toBe("ar");
    expect(detectLanguage(null, "新しい法律が発表されました", "")).toBe("ja");
  });

  it("scores stopwords for Latin languages", () => {
    expect(
      detectLanguage(null, "Le gouvernement annonce une réforme pour les travailleurs", ""),
    ).toBe("fr");
    expect(
      detectLanguage(null, "Der Bundestag hat das Gesetz mit Mehrheit beschlossen", ""),
    ).toBe("de");
  });

  it("returns null on ties and thin evidence (never guesses)", () => {
    expect(detectLanguage(null, "the and de la", "")).toBeNull(); // en 2 vs fr 2
    expect(detectLanguage(null, "Xyzzy qwerty blorpsnarg", "")).toBeNull();
    expect(detectLanguage(null, "", "")).toBeNull();
  });
});

describe("applyEngagementNorm", () => {
  it("percentile-ranks engagement per source: min 0, median 0.5, max 1", () => {
    const { items } = normalizeDrafts([
      makeDraft({ engagement_score: 10, url: "https://example.com/a" }),
      makeDraft({ engagement_score: 30, url: "https://example.com/b" }),
      makeDraft({ engagement_score: 20, url: "https://example.com/c" }),
    ]);
    const scored = applyEngagementNorm(items);
    const byUrl = new Map(scored.map((s) => [s.url, s.engagement_norm]));
    expect(byUrl.get("https://example.com/a")).toBe(0);
    expect(byUrl.get("https://example.com/c")).toBe(0.5);
    expect(byUrl.get("https://example.com/b")).toBe(1);
  });

  it("shares the average rank on ties", () => {
    const { items } = normalizeDrafts([
      makeDraft({ engagement_score: 5, url: "https://example.com/a" }),
      makeDraft({ engagement_score: 5, url: "https://example.com/b" }),
      makeDraft({ engagement_score: 10, url: "https://example.com/c" }),
    ]);
    const scored = applyEngagementNorm(items);
    const byUrl = new Map(scored.map((s) => [s.url, s.engagement_norm]));
    expect(byUrl.get("https://example.com/a")).toBe(0.25);
    expect(byUrl.get("https://example.com/b")).toBe(0.25);
    expect(byUrl.get("https://example.com/c")).toBe(1);
  });

  it("scores a lone item 1.0 and all-ties 0.5", () => {
    const single = normalizeDrafts([makeDraft({ engagement_score: 7 })]);
    expect(applyEngagementNorm(single.items)[0]?.engagement_norm).toBe(1);
    const tied = normalizeDrafts([
      makeDraft({ engagement_score: 7, url: "https://example.com/a" }),
      makeDraft({ engagement_score: 7, url: "https://example.com/b" }),
    ]);
    for (const s of applyEngagementNorm(tied.items)) expect(s.engagement_norm).toBe(0.5);
  });

  it("falls back to position 1 - pos/N without engagement", () => {
    const { items } = normalizeDrafts([
      makeDraft({ source: "rss", engagement_score: null, url: "https://example.com/a" }),
      makeDraft({ source: "rss", engagement_score: null, url: "https://example.com/b" }),
      makeDraft({ source: "rss", engagement_score: null, url: "https://example.com/c" }),
    ]);
    const norms = applyEngagementNorm(items).map((s) => s.engagement_norm);
    expect(norms).toEqual([1, 1 - 1 / 3, 1 - 2 / 3]);
  });

  it("mixes scored (percentile) and unscored (position) within one source", () => {
    const { items } = normalizeDrafts([
      makeDraft({ engagement_score: 100, url: "https://example.com/a" }),
      makeDraft({ engagement_score: null, url: "https://example.com/b" }),
      makeDraft({ engagement_score: 0, url: "https://example.com/c" }),
    ]);
    const byUrl = new Map(applyEngagementNorm(items).map((s) => [s.url, s.engagement_norm]));
    expect(byUrl.get("https://example.com/a")).toBe(1);
    expect(byUrl.get("https://example.com/c")).toBe(0);
    expect(byUrl.get("https://example.com/b")).toBeCloseTo(1 - 1 / 3, 10);
  });

  it("normalizes each source independently", () => {
    const { items } = normalizeDrafts([
      makeDraft({ source: "hackernews", engagement_score: 1, url: "https://example.com/a" }),
      makeDraft({ source: "hackernews", engagement_score: 2, url: "https://example.com/b" }),
      makeDraft({ source: "github", engagement_score: 1000, url: "https://example.com/c" }),
      makeDraft({ source: "github", engagement_score: 2000, url: "https://example.com/d" }),
    ]);
    const byUrl = new Map(applyEngagementNorm(items).map((s) => [s.url, s.engagement_norm]));
    expect(byUrl.get("https://example.com/a")).toBe(0);
    expect(byUrl.get("https://example.com/b")).toBe(1);
    expect(byUrl.get("https://example.com/c")).toBe(0);
    expect(byUrl.get("https://example.com/d")).toBe(1);
  });
});
