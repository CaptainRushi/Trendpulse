import { describe, expect, it } from "vitest";
import { openDatabase, applyMigrations } from "../../src/db/sqlite.js";
import { recordLlmCall } from "../../src/llm/log.js";

describe("recordLlmCall", () => {
  it("inserts ok and error rows into llm_calls", () => {
    const db = openDatabase(":memory:");
    try {
      applyMigrations(db);
      // llm_calls.run_id references runs(id): a run must exist first.
      db.prepare(
        "INSERT INTO runs (id, run_date, trigger, status, stages_requested, started_at) VALUES ('run-1','2026-09-30','manual','running','[]',datetime('now'))",
      ).run();
      recordLlmCall(db, "run-1", {
        tag: "jev_map",
        client: "jev",
        model: "jev",
        status: "ok",
        tokensIn: 900,
        tokensOut: 400,
        latencyMs: 1234,
        attempt: 1,
      });
      recordLlmCall(db, "run-1", {
        tag: "extract",
        client: "extractor",
        model: "extract-1",
        status: "http_error",
        httpStatus: 429,
        tokensIn: 0,
        tokensOut: 0,
        latencyMs: 55,
        attempt: 4,
        error: "Quota exceeded",
      });

      const rows = db
        .prepare("SELECT tag, client, model, status, http_status, tokens_in, tokens_out, latency_ms, attempt, error, run_id FROM llm_calls ORDER BY id")
        .all() as Record<string, unknown>[];
      expect(rows).toHaveLength(2);
      expect(rows[0]).toMatchObject({
        tag: "jev_map",
        client: "jev",
        status: "ok",
        tokens_in: 900,
        tokens_out: 400,
        run_id: "run-1",
      });
      expect(rows[1]).toMatchObject({
        tag: "extract",
        status: "http_error",
        http_status: 429,
        attempt: 4,
        error: "Quota exceeded",
      });
    } finally {
      db.close();
    }
  });

  it("allows a null run id (wizard probes)", () => {
    const db = openDatabase(":memory:");
    try {
      applyMigrations(db);
      recordLlmCall(db, null, {
        tag: "test",
        client: "jev",
        model: "jev",
        status: "ok",
        tokensIn: 5,
        tokensOut: 2,
        latencyMs: 100,
        attempt: 1,
      });
      const row = db.prepare("SELECT run_id FROM llm_calls").get() as { run_id: unknown };
      expect(row.run_id).toBeNull();
    } finally {
      db.close();
    }
  });
});
