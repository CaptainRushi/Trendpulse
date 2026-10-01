/**
 * Sources: config + health per source. Missing rows read as defaults
 * (enabled, limit 50, empty config) — the table is seeded on first run.
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { COLLECTORS } from "../collectors/registry.js";
import { badRequest } from "./errors.js";
import type { AppContext } from "./context.js";
import { SourceKey } from "../sheets/schema.js";

const SourceEntry = z.object({
  key: SourceKey,
  label: z.string(),
  enabled: z.boolean(),
  item_limit: z.number().int(),
  config: z.record(z.string(), z.unknown()),
  requires: z.array(z.string()),
  last_status: z.string().nullable(),
  last_error: z.string().nullable(),
  last_run_at: z.string().nullable(),
  last_items: z.number().nullable(),
});
export type SourceEntry = z.infer<typeof SourceEntry>;

interface SourceRow {
  key: string;
  enabled: number;
  item_limit: number;
  config_json: string;
  last_status: string | null;
  last_error: string | null;
  last_run_at: string | null;
  last_items: number | null;
}

function parseConfig(raw: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed === "object" && parsed !== null) return parsed as Record<string, unknown>;
  } catch {
    // Corrupt config_json degrades to empty (operator error, visible in UI).
  }
  return {};
}

export function sourceEntry(row: SourceRow | undefined, key: z.infer<typeof SourceKey>): SourceEntry {
  const collector = COLLECTORS[key];
  return SourceEntry.parse({
    key,
    label: collector.label,
    enabled: row ? row.enabled === 1 : true,
    item_limit: row?.item_limit ?? 50,
    config: row ? parseConfig(row.config_json) : {},
    requires: collector.requires,
    last_status: row?.last_status ?? null,
    last_error: row?.last_error ?? null,
    last_run_at: row?.last_run_at ?? null,
    last_items: row?.last_items ?? null,
  });
}

const SourceUpdate = z
  .object({
    enabled: z.boolean().optional(),
    item_limit: z.number().int().min(1).optional(),
    config: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

export function registerSources(app: FastifyInstance, ctx: AppContext): void {
  app.get("/api/sources", () => {
    const rows = ctx.db.prepare("SELECT * FROM sources").all() as SourceRow[];
    const byKey = new Map(rows.map((row) => [row.key, row]));
    const entries = (Object.keys(COLLECTORS) as z.infer<typeof SourceKey>[]).map((key) =>
      sourceEntry(byKey.get(key), key),
    );
    return z.array(SourceEntry).parse(entries);
  });

  app.put("/api/sources/:key", (request) => {
    const params = z.object({ key: SourceKey }).safeParse(request.params);
    if (!params.success) throw badRequest("Unknown source key.");
    const body = SourceUpdate.safeParse(request.body);
    if (!body.success) {
      const issue = body.error.issues[0];
      throw badRequest(
        `Invalid body${issue ? `: ${issue.path.join(".")} ${issue.message}` : ""}`,
      );
    }
    const existing = ctx.db.prepare("SELECT * FROM sources WHERE key = ?").get(params.data.key) as
      | SourceRow
      | undefined;
    const enabled = body.data.enabled ?? (existing ? existing.enabled === 1 : true);
    const itemLimit = body.data.item_limit ?? existing?.item_limit ?? 50;
    const configJson = JSON.stringify(
      body.data.config ?? (existing ? parseConfig(existing.config_json) : {}),
    );
    ctx.db
      .prepare(
        `INSERT INTO sources (key, enabled, item_limit, config_json)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET enabled = excluded.enabled, item_limit = excluded.item_limit, config_json = excluded.config_json`,
      )
      .run(params.data.key, enabled ? 1 : 0, itemLimit, configJson);
    const updated = ctx.db.prepare("SELECT * FROM sources WHERE key = ?").get(params.data.key) as SourceRow;
    return sourceEntry(updated, params.data.key);
  });
}
