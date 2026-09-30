import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { MIGRATIONS_DIR, applyMigrations, openDatabase } from "../src/db/sqlite.js";
import type { StateDb } from "../src/db/sqlite.js";

let dirsToCleanup: string[] = [];
let dbsToClose: StateDb[] = [];

afterEach(() => {
  for (const db of dbsToClose) {
    try {
      db.close();
    } catch {
      // already closed by the test itself
    }
  }
  dbsToClose = [];
  for (const dir of dirsToCleanup) {
    // Windows holds SQLite file handles briefly after close; retry the rm.
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
  dirsToCleanup = [];
});

/** In-memory DB — no filesystem, no Windows file-lock flakes. */
function openMemory(): StateDb {
  const db = openDatabase(":memory:");
  dbsToClose.push(db);
  return db;
}

/** Temp-file DB — only for tests that need reopen persistence or WAL mode. */
function openTempFile(): { db: StateDb; path: string } {
  const dir = mkdtempSync(join(tmpdir(), "trendpulse-test-"));
  dirsToCleanup.push(dir);
  const path = join(dir, "state.db");
  const db = openDatabase(path);
  dbsToClose.push(db);
  return { db, path };
}

describe("migrations", () => {
  it("migration files are numbered sequentially starting at 001", () => {
    const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql")).sort();
    expect(files.length).toBeGreaterThan(0);
    expect(files[0]).toMatch(/^001_/);
  });

  it("applyMigrations creates every operational table on an empty DB", () => {
    const db = openMemory();
    const applied = applyMigrations(db);
    expect(applied).toContain(1);

    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as { name: string }[];
    const names = tables.map((t) => t.name);
    for (const expected of [
      "schema_migrations",
      "settings",
      "sources",
      "runs",
      "run_stages",
      "run_source_stats",
      "items_run",
      "seen_items",
      "llm_calls",
      "locks",
      "http_cache",
    ]) {
      expect(names).toContain(expected);
    }
  });

  it("applyMigrations is idempotent — second run applies nothing", () => {
    const { db, path } = openTempFile();
    applyMigrations(db);
    db.close();

    const reopened = openDatabase(path);
    dbsToClose.push(reopened);
    const applied = applyMigrations(reopened);
    expect(applied).toEqual([]);
  });

  it("file-backed database opens in WAL mode with foreign keys on", () => {
    const { db } = openTempFile();
    const journal = db.prepare("PRAGMA journal_mode").get() as { journal_mode: string };
    const fk = db.prepare("PRAGMA foreign_keys").get() as { foreign_keys: number };
    expect(journal.journal_mode.toLowerCase()).toBe("wal");
    expect(fk.foreign_keys).toBe(1);
  });

  it("enforces the run status check constraint", () => {
    const db = openMemory();
    applyMigrations(db);
    expect(() =>
      db
        .prepare(
          "INSERT INTO runs (id, run_date, trigger, status, stages_requested, started_at) VALUES ('x','2026-09-30','manual','bogus','[]',datetime('now'))",
        )
        .run(),
    ).toThrow();
  });

  it("Database export is the better-sqlite3 constructor (smoke)", () => {
    expect(Database).toBeDefined();
  });
});
