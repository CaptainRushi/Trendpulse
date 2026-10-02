/**
 * Item generator (07 §1.3): make N items with controlled titles, sources,
 * engagement, and deliberate near-duplicates. Pure — no DB, no clock. Feeds
 * golden files, dedupe/score tests, and the verify board.
 */
import { RawTrendRecord } from "../../src/sheets/schema.js";
import type { RawTrendRecord as Raw, SourceKey } from "../../src/sheets/schema.js";

const SOURCES: SourceKey[] = ["hackernews", "reddit", "github", "wikipedia", "rss"];

export interface GenerateOptions {
  count: number;
  /** Cycle through these sources (default: the five MVP HTTP sources). */
  sources?: SourceKey[];
  /** engagement_norm assigned i → (i % 10) / 10 (default) or a custom fn. */
  normOf?: (index: number) => number;
  /** Prefix for titles/urls so near-dupes are controllable. */
  titlePrefix?: string;
}

/** N distinct items, one per line index, deterministic. */
export function makeItems(options: GenerateOptions): Raw[] {
  const sources = options.sources ?? SOURCES;
  const prefix = options.titlePrefix ?? "Story";
  return Array.from({ length: options.count }, (_, i) =>
    RawTrendRecord.parse({
      id: `01FACTORY${String(i).padStart(20, "0")}`,
      run_id: "run-factory",
      collected_at: "2026-09-30T06:00:00.000Z",
      source: sources[i % sources.length] ?? "hackernews",
      source_item_id: null,
      url: `https://factory.example.com/${prefix.toLowerCase()}-${String(i)}`,
      title: `${prefix} ${String(i)} about widgets`,
      snippet: `Snippet ${String(i)}.`,
      author: null,
      published_at: null,
      engagement_score: i,
      engagement_extra: {},
      engagement_norm: (options.normOf ?? ((n) => (n % 10) / 10))(i),
      language: "en",
      region: null,
      content_hash: `factory-hash-${String(i)}`,
      merged_sources: [],
      extraction_model: null,
      source_label: null,
    }),
  );
}

/**
 * Near-duplicate pair: same story on two sources, titles ≥ 0.85 similar
 * (differ only by trailing punctuation), higher engagement on the second so
 * the merge keeps it and records `merged_sources`. NRM-03 anchor.
 */
export function makeDuplicatePair(): [Raw, Raw] {
  const lower = makeItems({ count: 1 })[0]!;
  const higher = makeItems({ count: 1 })[0]!;
  return [
    RawTrendRecord.parse({
      ...lower,
      id: "01FACTORYDUPA0000000000000000000",
      url: "https://news.ycombinator.example/item?id=1",
      source: "hackernews",
      title: "New AI model released by lab",
      engagement_norm: 0.4,
    }),
    RawTrendRecord.parse({
      ...higher,
      id: "01FACTORYDUPB0000000000000000000",
      url: "https://reddit.example.com/r/ai/comments/1",
      source: "reddit",
      title: "New AI model released by lab!",
      engagement_norm: 0.9,
    }),
  ];
}
