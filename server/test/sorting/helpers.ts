/** Record builders for sorting tests. */
import { RawTrendRecord } from "../../src/sheets/schema.js";
import type { RawTrendRecord as Raw } from "../../src/sheets/schema.js";
import type { SourceKey } from "../../src/sheets/schema.js";

let counter = 0;

export function makeRawItem(overrides: Partial<Raw> = {}): Raw {
  counter += 1;
  const n = counter;
  return RawTrendRecord.parse({
    id: `01TESTJEV${String(n).padStart(18, "0")}`,
    run_id: "run-test",
    collected_at: "2026-09-30T06:00:00.000Z",
    source: "hackernews",
    source_item_id: null,
    url: `https://example.com/story-${String(n)}`,
    title: `Story ${String(n)}`,
    snippet: `Snippet ${String(n)}`,
    author: null,
    published_at: null,
    engagement_score: n,
    engagement_extra: {},
    engagement_norm: 0.5,
    language: "en",
    region: null,
    content_hash: `hash-${String(n)}`,
    merged_sources: [],
    extraction_model: null,
    source_label: null,
    ...overrides,
  });
}

export function withSource(source: SourceKey, count: number): Raw[] {
  return Array.from({ length: count }, (_, i) =>
    makeRawItem({ source, url: `https://${source}.example.com/${String(i)}` }),
  );
}
