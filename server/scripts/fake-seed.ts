/**
 * fake-seed (Doc 16 G5, Doc 19 Q6) — minimal demo seed for the live graph.
 * Inserts one demo run with two topics backed by REAL refreshable items
 * (HN 8863, github Panniantong/agent-reach) plus baseline samples, so Today
 * shows the hero immediately in `npm run dev`. Idempotent (fixed ids,
 * upserts). --pulse-fast writes settings pulse_interval_ms=10000.
 *
 * Doc 19: per-category sets for ai, finance and science, cached labels
 * covering every assignment branch (confident-selected, confident
 * off-category, low-confidence-by-target, no-label-no-target), and the
 * my_categories selection the panels read.
 */
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { loadEnvFiles } from "../src/config/loadEnv.js";
import { loadConfig } from "../src/config/env.js";
import { applyMigrations, openDatabase } from "../src/db/sqlite.js";
import { writeSetting } from "../src/config/settings.js";
import { writeCachedLabels } from "../src/llm/labelCache.js";
import { QUESTION_SET_VERSION } from "../src/sorting/questions.js";
import { repoDbPath } from "./lib/dbPath.js";
import { writeLatestSet } from "../src/pulse/index.js";

loadEnvFiles();
const config = loadConfig();
const fast = process.argv.includes("--pulse-fast");

const dbPath = repoDbPath(import.meta.url);
mkdirSync(dirname(dbPath), { recursive: true });
const db = openDatabase(dbPath);
applyMigrations(db);

const today = new Date().toLocaleDateString("en-CA", { timeZone: config.tz });
const now = new Date().toISOString();
db.prepare(
  "INSERT INTO runs (id, run_date, trigger, status, stages_requested, started_at) VALUES ('demo-run-1', ?, 'manual', 'success', '[]', ?) " +
    "ON CONFLICT(id) DO UPDATE SET run_date = excluded.run_date",
).run(today, now);

const items = [
  { id: "demo-hn-8863", source: "hackernews", url: "https://news.ycombinator.com/item?id=8863", engagement: 104, sid: "8863" },
  { id: "demo-gh-reach", source: "github", url: "https://github.com/Panniantong/agent-reach", engagement: 90222, sid: "" },
  { id: "demo-hn-2", source: "hackernews", url: "https://news.ycombinator.com/item?id=1", engagement: 10, sid: "1" },
  { id: "demo-fin-1", source: "rss", url: "https://example.com/demo-fin-1", engagement: 12, sid: "demo-fin-1" },
  { id: "demo-sci-1", source: "rss", url: "https://example.com/demo-sci-1", engagement: 9, sid: "demo-sci-1" },
  // Assignment-branch fixtures (Doc 19 Q3 rule): confident off-category,
  // low-confidence with a target, and unlabeled without a target.
  { id: "demo-off-1", source: "rss", url: "https://example.com/demo-off-1", engagement: 5, sid: "demo-off-1" },
  { id: "demo-low-1", source: "rss", url: "https://example.com/demo-low-1", engagement: 4, sid: "demo-low-1" },
  { id: "demo-none-1", source: "rss", url: "https://example.com/demo-none-1", engagement: 3, sid: "demo-none-1" },
];
const insertItem = db.prepare(
  "INSERT INTO items_run (id, run_id, run_date, source, content_hash, payload_json) VALUES (?, 'demo-run-1', ?, ?, ?, ?) " +
    "ON CONFLICT(id) DO UPDATE SET payload_json = excluded.payload_json",
);
for (const item of items) {
  insertItem.run(
    item.id,
    today,
    item.source,
    `demo-${item.id}`,
    JSON.stringify({ url: item.url, engagement_score: item.engagement, source_item_id: item.sid }),
  );
}

const result = writeLatestSet(
  db,
  "demo-run-1",
  today,
  [
    { topic_id: "demo-t1", rank: 1, title: "Demo: Dropbox YC launch", trend_score: 92, source_count: 3, hidden: false, evidence_item_ids: ["demo-hn-8863", "demo-gh-reach"] },
    { topic_id: "demo-t2", rank: 2, title: "Demo: second story", trend_score: 61, source_count: 1, hidden: false, evidence_item_ids: ["demo-hn-2"] },
  ],
  config.pulseTopN,
  now,
);

// Category demo set (Doc 19: per-category sets): an ai set next to the demo
// set, plus sort events so the animation replays on load.
const catResult = writeLatestSet(
  db,
  "demo-run-1",
  today,
  [
    { topic_id: "demo-ai-1", rank: 1, title: "Demo: AI funding round", trend_score: 88, source_count: 2, hidden: false, evidence_item_ids: ["demo-hn-8863"], category: "AI" },
    { topic_id: "demo-fin-1", rank: 1, title: "Demo: bank earnings beat", trend_score: 74, source_count: 1, hidden: false, evidence_item_ids: ["demo-fin-1"], category: "Finance" },
    { topic_id: "demo-sci-1", rank: 1, title: "Demo: lab result published", trend_score: 69, source_count: 1, hidden: false, evidence_item_ids: ["demo-sci-1"], category: "Science" },
  ],
  config.pulseTopN,
  now,
);
const demoEvents: Record<string, unknown>[] = [
  { type: "sort_phase", phase: "classify" },
  {
    type: "sort_batch",
    stage: "classify",
    items: [
      { id: "demo-hn-8863", t: "Demo: Dropbox YC launch", c: "ai", q: 0.9, f: false, d: false, o: false },
      { id: "demo-gh-reach", t: "agent-reach", c: "ai", q: 0.8, f: false, d: false, o: false },
    ],
    done: 2,
    total: 2,
    jev_calls: 2,
    fallback_calls: 0,
    cost_usd: 0.0001,
  },
  { type: "sort_phase", phase: "done" },
];
const insertEvent = db.prepare("INSERT INTO sort_events (run_id, seq, payload_json) VALUES ('demo-run-1', ?, ?) ON CONFLICT(run_id, seq) DO NOTHING");
demoEvents.forEach((event, i) => {
  insertEvent.run(i + 1, JSON.stringify(event));
});

if (fast) {
  writeSetting(db, "pulse_interval_ms", 10_000);
  process.stdout.write("pulse-fast: sampler interval set to 10 s (settings pulse_interval_ms).\n");
}
// Panels read my_categories: seed the three demo categories.
writeSetting(db, "my_categories", ["ai", "finance", "science"]);
// Cached labels covering every assignment branch (synthetic fixtures).
const branchLabels = [
  { item: "demo-fin-1", choice: "Finance", confidence: 0.9 },
  { item: "demo-sci-1", choice: "Science", confidence: 0.9 },
  { item: "demo-off-1", choice: "Sports", confidence: 0.9 },
  { item: "demo-low-1", choice: "AI", confidence: 0.5 },
];
for (const entry of branchLabels) {
  writeCachedLabels(db, {
    itemId: entry.item,
    contentHash: `demo-${entry.item}`,
    questionSetVersion: QUESTION_SET_VERSION,
    model: config.jevModel,
    classifier: "jev",
    answers: {
      category: {
        answerJson: JSON.stringify({ kind: "choice", choice: entry.choice, confidence: entry.confidence }),
        confidence: entry.confidence,
      },
    },
  });
}
process.stdout.write(`seeded ${today}: indexed ${String(result.indexed)}, baselines ${String(result.baselined)}.\n`);
process.stdout.write(`category sets: indexed ${String(catResult.indexed)} (ai/finance/science), ${String(demoEvents.length)} replay events, my_categories=ai,finance,science.\n`);
db.close();
