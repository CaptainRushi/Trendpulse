import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import type { default as BetterSqlite3Type } from "better-sqlite3";

export type StateDb = BetterSqlite3Type.Database;

const here = dirname(fileURLToPath(import.meta.url));

/** Directory holding NNN_name.sql migrations. Exported for tests. */
export const MIGRATIONS_DIR = join(here, "migrations");

/**
 * Open (creating parent dirs not needed — data/ is created by the caller)
 * with WAL mode + foreign keys, per TRD §10 / schema §2.
 */
export function openDatabase(dbPath: string): StateDb {
  const db: StateDb = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  return db;
}

interface MigrationFile {
  version: number;
  name: string;
  filename: string;
}

/** NNN_name.sql, ordered. Throws on gaps or duplicates (fail fast, never half-apply). */
export function listMigrations(dir: string = MIGRATIONS_DIR): MigrationFile[] {
  const files = readdirSync(dir)
    .filter((f) => /^\d+_.+\.sql$/.test(f))
    .sort();
  const migrations = files.map((filename) => {
    const match = filename.match(/^(\d+)_(.+)\.sql$/);
    if (!match?.[1] || !match[2]) throw new Error(`Bad migration filename: ${filename}`);
    return { version: Number(match[1]), name: match[2], filename };
  });
  migrations.forEach((m, i) => {
    if (m.version !== i + 1) {
      throw new Error(
        `Migration version gap: expected ${String(i + 1)}, found ${String(m.version)} (${m.filename})`,
      );
    }
  });
  return migrations;
}

/**
 * Apply pending migrations inside a single transaction each.
 * Returns the versions applied (empty = already current). Idempotent.
 */
export function applyMigrations(db: StateDb, dir: string = MIGRATIONS_DIR): number[] {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    applied_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
  const applied = new Set(
    (db.prepare("SELECT version FROM schema_migrations").all() as { version: number }[]).map(
      (r) => r.version,
    ),
  );
  const done: number[] = [];
  for (const m of listMigrations(dir)) {
    if (applied.has(m.version)) continue;
    const sql = readFileSync(join(dir, m.filename), "utf8");
    db.transaction(() => {
      db.exec(sql);
      db.prepare("INSERT INTO schema_migrations (version, name) VALUES (?, ?)").run(m.version, m.name);
    })();
    done.push(m.version);
  }
  return done;
}
