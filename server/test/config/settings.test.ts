import { describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config/env.js";
import {
  readSettingsMap,
  resolveEffectiveSettings,
  scoreWeightsOr,
} from "../../src/config/settings.js";
import { DEFAULT_SCORE_WEIGHTS } from "../../src/sorting/score.js";
import { openTestDb } from "../pipeline/helpers.js";

const config = loadConfig({});

function seed(db: ReturnType<typeof openTestDb>, entries: Record<string, unknown>): void {
  const insert = db.prepare("INSERT INTO settings (key, value_json) VALUES (?, ?)");
  for (const [key, value] of Object.entries(entries)) {
    insert.run(key, JSON.stringify(value));
  }
}

describe("readSettingsMap", () => {
  it("parses value_json per key and names corrupt rows", () => {
    const db = openTestDb();
    try {
      seed(db, { sort_batch_size: 25 });
      db.prepare("INSERT INTO settings (key, value_json) VALUES ('broken', '{oops')").run();
      expect(() => readSettingsMap(db)).toThrow(/settings row 'broken' holds corrupt JSON/);
    } finally {
      db.close();
    }
  });
});

describe("scoreWeightsOr", () => {
  it("accepts full numeric weights, falls back otherwise", () => {
    const good = { engagement: 0.5, diversity: 0.2, relevance: 0.2, novelty: 0.1 };
    expect(scoreWeightsOr(good, DEFAULT_SCORE_WEIGHTS)).toEqual(good);
    expect(scoreWeightsOr({ engagement: 1 }, DEFAULT_SCORE_WEIGHTS)).toBe(DEFAULT_SCORE_WEIGHTS);
    expect(scoreWeightsOr("nope", DEFAULT_SCORE_WEIGHTS)).toBe(DEFAULT_SCORE_WEIGHTS);
    expect(
      scoreWeightsOr(
        { engagement: -1, diversity: 0.5, relevance: 0.5, novelty: 0.5 },
        DEFAULT_SCORE_WEIGHTS,
      ),
    ).toBe(DEFAULT_SCORE_WEIGHTS);
  });
});

describe("resolveEffectiveSettings", () => {
  it("prefers settings rows over env-derived defaults", () => {
    const db = openTestDb();
    try {
      seed(db, { retention_days: 45, dedupe_days: 7, retention_mode: "delete" });
      const { settings, warnings } = resolveEffectiveSettings(db, config);
      expect(settings.retentionDays).toBe(45);
      expect(settings.dedupeDays).toBe(7);
      expect(settings.retentionMode).toBe("delete");
      expect(settings.sortBatchSize).toBe(config.sortBatchSize);
      expect(settings.scoreWeights).toEqual(DEFAULT_SCORE_WEIGHTS);
      expect(warnings).toEqual([]);
    } finally {
      db.close();
    }
  });

  it("warns and falls back on malformed rows", () => {
    const db = openTestDb();
    try {
      seed(db, { score_weights: { engagement: 1 }, retention_mode: "shred", sort_batch_size: -5 });
      const { settings, warnings } = resolveEffectiveSettings(db, config);
      expect(settings.scoreWeights).toEqual(DEFAULT_SCORE_WEIGHTS);
      expect(settings.retentionMode).toBe("archive");
      expect(settings.sortBatchSize).toBe(config.sortBatchSize); // silent fallback for plain ints
      expect(warnings).toHaveLength(2);
    } finally {
      db.close();
    }
  });

  it("survives a corrupt settings row with a warning", () => {
    const db = openTestDb();
    try {
      db.prepare("INSERT INTO settings (key, value_json) VALUES ('broken', '{oops')").run();
      const { settings, warnings } = resolveEffectiveSettings(db, config);
      expect(settings.sortBatchSize).toBe(config.sortBatchSize);
      expect(warnings).toHaveLength(1);
    } finally {
      db.close();
    }
  });
});
