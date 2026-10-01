/** Shared API route-test scaffolding: in-memory DB, fake sheets, silent log. */
import pino from "pino";
import { loadConfig } from "../../src/config/env.js";
import type { TrendPulseConfig } from "../../src/config/env.js";
import type { AppContext } from "../../src/api/context.js";
import type { StateDb } from "../../src/db/sqlite.js";
import { EventBus } from "../../src/pipeline/events.js";
import { SheetsRepo } from "../../src/sheets/repo.js";
import { SheetsWriteQueue } from "../../src/sheets/queue.js";
import { SortedTrendRecord } from "../../src/sheets/schema.js";
import type { SortedTrendRecord as Sorted } from "../../src/sheets/schema.js";
import { FakeSheetsClient } from "../fakes/fakeSheetsClient.js";
import { openTestDb } from "../pipeline/helpers.js";

export interface TestApi {
  ctx: AppContext;
  db: StateDb;
  sheets: FakeSheetsClient;
  repo: SheetsRepo;
  close(): Promise<void>;
}

export function testContext(overrides: {
  config?: TrendPulseConfig;
  events?: EventBus;
  sheetsClient?: FakeSheetsClient;
} = {}): TestApi {
  const db = openTestDb();
  const sheets = overrides.sheetsClient ?? new FakeSheetsClient();
  const ctx: AppContext = {
    version: "0.1.0-test",
    config: overrides.config ?? loadConfig({ GOOGLE_SHEET_ID: "test-sheet" }),
    db,
    log: pino({ level: "silent" }),
    events: overrides.events ?? new EventBus(),
    sheetsClient: sheets,
  };
  const repo = new SheetsRepo(sheets, {
    spreadsheetId: "test-sheet",
    cacheTtlS: 60,
    queue: new SheetsWriteQueue({ minGapMs: 0, sleep: () => Promise.resolve() }),
  });
  return {
    ctx,
    db,
    sheets,
    repo,
    close: () => {
      db.close();
      return Promise.resolve();
    },
  };
}

let sortedCounter = 0;

export function makeSortedTopic(overrides: Partial<Sorted> = {}): Sorted {
  sortedCounter += 1;
  const n = sortedCounter;
  return SortedTrendRecord.parse({
    topic_id: `01TESTTOPIC${String(n).padStart(16, "0")}`,
    run_id: "run-test",
    run_date: "2026-09-30",
    rank: n,
    title: `Topic ${String(n)}`,
    summary: `Summary ${String(n)}.`,
    category: "Tech",
    tags: ["t"],
    trend_score: 80,
    score_engagement: 0.8,
    score_diversity: 0.5,
    score_relevance: 0.8,
    score_novelty: 0.6,
    momentum: "rising",
    sentiment: "neutral",
    why_trending: "Coverage.",
    content_angles: ["Angle one"],
    evidence_item_ids: [],
    source_count: 1,
    top_urls: [],
    jev_model: "stub-jev",
    prompt_version: "v1",
    sorted_at: "2026-09-30T07:00:00.000Z",
    is_latest: true,
    hidden: false,
    ...overrides,
  });
}
