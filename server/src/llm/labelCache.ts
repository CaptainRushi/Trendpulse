/**
 * SQLite LabelCache over `item_labels` (migration 003). Same item, same
 * question set, same model → no Jev call. A model (or question-set) change
 * misses and reclassifies.
 *
 * Key note: the cache key folds the question in
 * (`content_hash|version|model|question`) — the Day-1 formula without the
 * question would collide across an item's questions under the UNIQUE key.
 */
import type { StateDb } from "../db/sqlite.js";
import { sha1 } from "../utils/hash.js";

export interface CachedLabel {
  question: string;
  answerJson: string;
  confidence: number | null;
  classifier: string;
}

/** Discriminated so multi-question items never collide on the UNIQUE key. */
export function cacheKeyFor(contentHash: string, questionSetVersion: string, model: string, question: string): string {
  return sha1(`${contentHash}|${questionSetVersion}|${model}|${question}`);
}

export function readCachedLabels(
  db: StateDb,
  itemId: string,
  questionSetVersion: string,
  model: string,
): CachedLabel[] {
  return db
    .prepare(
      "SELECT question, answer_json AS answerJson, confidence, classifier FROM item_labels WHERE item_id = ? AND question_set_version = ? AND model = ?",
    )
    .all(itemId, questionSetVersion, model) as CachedLabel[];
}

export function writeCachedLabels(
  db: StateDb,
  args: {
    itemId: string;
    contentHash: string;
    questionSetVersion: string;
    model: string;
    classifier: string;
    answers: Record<string, { answerJson: string; confidence: number | null }>;
  },
): void {
  const insert = db.prepare(
    `INSERT INTO item_labels
       (item_id, question, answer_json, confidence, model, question_set_version, classifier, cache_key)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(cache_key) DO UPDATE SET
       answer_json = excluded.answer_json, confidence = excluded.confidence, classifier = excluded.classifier`,
  );
  const write = db.transaction(() => {
    for (const [question, answer] of Object.entries(args.answers)) {
      insert.run(
        args.itemId,
        question,
        answer.answerJson,
        answer.confidence,
        args.model,
        args.questionSetVersion,
        args.classifier,
        cacheKeyFor(args.contentHash, args.questionSetVersion, args.model, question),
      );
    }
  });
  write();
}
