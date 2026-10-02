/** Stub Jev client + record builders for sorting tests. */
import { LlmValidationError } from "../../src/llm/client.js";
import type { JsonRequest, JsonResult } from "../../src/llm/client.js";
import { RawTrendRecord } from "../../src/sheets/schema.js";
import type { RawTrendRecord as Raw } from "../../src/sheets/schema.js";
import type { SourceKey } from "../../src/sheets/schema.js";
import type { JevJsonClient } from "../../src/sorting/map.js";

/**
 * In-process Jev double. The handler receives (tag, user-message) and
 * returns the reply object; unparseable replies become LlmValidationError,
 * mirroring the real client's post-repair contract. Throw
 * LlmValidationError from the handler to simulate a failed batch.
 */
export class StubJevClient implements JevJsonClient {
  readonly modelId = "stub-jev";
  readonly calls: { tag: string; system: string; user: string }[] = [];

  constructor(private readonly handler: (tag: string, user: string) => unknown) {}

  async json<T>(request: JsonRequest<T>): Promise<JsonResult<T>> {
    this.calls.push({ tag: request.tag, system: request.system, user: request.user });
    const raw = this.handler(request.tag, request.user);
    const parsed = request.schema.safeParse(raw);
    if (!parsed.success) {
      throw new LlmValidationError(`stub-jev: invalid ${request.tag} shape`);
    }
    return {
      data: parsed.data,
      usage: { tokensIn: 0, tokensOut: 0 },
      model: this.modelId,
      latencyMs: 0,
      repaired: false,
    };
  }

  callsTo(tag: string): { tag: string; system: string; user: string }[] {
    return this.calls.filter((call) => call.tag === tag);
  }
}

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

/** Extract `[id]` markers from a map user message (one per ITEMS line). */
export function mapInputIds(user: string): string[] {
  const ids: string[] = [];
  for (const line of user.split("\n")) {
    const match = /^\[(.+?)\]/.exec(line);
    if (match?.[1]) ids.push(match[1]);
  }
  return ids;
}

/** Parse `items: a,b,c` lists from a reduce user message. */
export function reduceInputIdGroups(user: string): string[][] {
  const groups: string[][] = [];
  for (const line of user.split("\n")) {
    const match = /items: (\S+)/.exec(line);
    if (match?.[1]) groups.push(match[1].split(",").filter((id) => id.length > 0));
  }
  return groups;
}
