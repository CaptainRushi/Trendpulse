/**
 * Dedupe stage (TRD §6 stage 3): within-run near-duplicate merge + cross-day
 * `seen_items` filtering.
 *
 * Merge is a pure function of the input SET (not its order): candidates are
 * processed in a canonical order (engagement desc, content_hash asc), so
 * reordered feeds produce the same keeper set. Emission follows input order
 * for stable sheet output. Exact content_hash matches merge first (same
 * canonical URL = same story, e.g. utm variants), then trigram Jaccard on
 * normalized titles at threshold 0.85. Keepers keep their own fields and
 * gain `merged_sources` (distinct absorbed sources, keeper's own excluded);
 * every absorbed hash is reported so the caller can record it in
 * `seen_items` — otherwise the absorbed URL would resurrect tomorrow.
 *
 * Cross-day rule: drop a hash seen in the last DEDUPE_DAYS (by
 * `last_seen_date`). `seen_items` rows are written ONLY after the sheet
 * append succeeds (see pipeline/persist.ts) — never here.
 */
import type { StateDb } from "../db/sqlite.js";
import type { SourceKey } from "../sheets/schema.js";
import type { NormalizedItem } from "./normalize.js";

/** TRD §6: trigram Jaccard ≥ 0.85 merges. */
export const NEAR_DUPLICATE_THRESHOLD = 0.85;

export interface MergedItem extends NormalizedItem {
  merged_sources: SourceKey[];
}

export interface AbsorbedItem {
  content_hash: string;
  source: SourceKey;
}

export interface MergeResult {
  items: MergedItem[];
  /** Distinct content_hashes absorbed (for seen_items recording). */
  absorbedHashes: string[];
  /** Absorbed hashes with their own source (seen_items needs both). */
  absorbed: AbsorbedItem[];
  /** Keeper content_hash → entries it absorbed (for the items_run sidecar). */
  absorbedByKeeper: Map<string, AbsorbedItem[]>;
  /** Input items that survived as keepers. */
  kept: number;
  /** Input items absorbed into a keeper. */
  merged: number;
}

/** Lowercase, strip punctuation (Unicode-aware), collapse spaces. */
export function normalizeTitleForMatch(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Character trigrams; a lone gram for strings shorter than 3 chars. */
export function trigrams(normalized: string): Set<string> {
  const grams = new Set<string>();
  if (normalized.length < 3) {
    if (normalized.length > 0) grams.add(normalized);
    return grams;
  }
  for (let i = 0; i + 3 <= normalized.length; i++) {
    grams.add(normalized.slice(i, i + 3));
  }
  return grams;
}

/** |A∩B| / |A∪B|. Both empty (equal short strings) → 1; one empty → 0. */
export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  const [smaller, larger] = a.size <= b.size ? [a, b] : [b, a];
  for (const gram of smaller) if (larger.has(gram)) intersection += 1;
  const union = a.size + b.size - intersection;
  return union === 0 ? 1 : intersection / union;
}

export function titleSimilarity(a: string, b: string): number {
  const left = normalizeTitleForMatch(a);
  const right = normalizeTitleForMatch(b);
  if (left === right) return 1;
  return jaccard(trigrams(left), trigrams(right));
}

function engagementOf(item: NormalizedItem): number {
  return item.engagement_score ?? -1;
}

/**
 * Total, deterministic ordering for keeper choice: highest engagement wins,
 * every tie broken by content (never by input position).
 */
function compareKeeperPriority(x: NormalizedItem, y: NormalizedItem): number {
  const engagement = engagementOf(y) - engagementOf(x);
  if (engagement !== 0) return engagement;
  if (x.content_hash !== y.content_hash) return x.content_hash < y.content_hash ? -1 : 1;
  if (x.title !== y.title) return x.title < y.title ? -1 : 1;
  if (x.source !== y.source) return x.source < y.source ? -1 : 1;
  const rest = JSON.stringify(x);
  const other = JSON.stringify(y);
  if (rest === other) return 0;
  return rest < other ? -1 : 1;
}

export function mergeNearDuplicates(
  items: NormalizedItem[],
  threshold: number = NEAR_DUPLICATE_THRESHOLD,
): MergeResult {
  // Exact-hash pre-pass: same canonical URL is the same story even when the
  // title was edited (utm variants always land here).
  const byHash = new Map<string, NormalizedItem[]>();
  for (const item of items) {
    const group = byHash.get(item.content_hash);
    if (group) group.push(item);
    else byHash.set(item.content_hash, [item]);
  }
  const afterExact: NormalizedItem[] = [];
  const absorbed: AbsorbedItem[] = [];
  const absorbedByKeeper = new Map<string, AbsorbedItem[]>();
  const absorbedSourceLists = new Map<NormalizedItem, SourceKey[]>();
  const absorb = (keeper: NormalizedItem, item: NormalizedItem): void => {
    const entry: AbsorbedItem = { content_hash: item.content_hash, source: item.source };
    absorbed.push(entry);
    // Group by keeper for the items_run sidecar; a keeper that is itself
    // absorbed later carries its group along (transfer + delete old key).
    const group = absorbedByKeeper.get(keeper.content_hash) ?? [];
    group.push(entry);
    const inherited = absorbedByKeeper.get(item.content_hash);
    if (inherited && item.content_hash !== keeper.content_hash) {
      group.push(...inherited);
      absorbedByKeeper.delete(item.content_hash);
    }
    absorbedByKeeper.set(keeper.content_hash, group);
    // An exact-pass keeper may already carry absorbed sources; when it is
    // itself absorbed, those sources transfer to the new keeper.
    const inheritedSources = absorbedSourceLists.get(item) ?? [];
    const list = absorbedSourceLists.get(keeper) ?? [];
    for (const source of [item.source, ...inheritedSources]) {
      if (source !== keeper.source && !list.includes(source)) list.push(source);
    }
    absorbedSourceLists.set(keeper, list);
  };
  for (const group of byHash.values()) {
    const first = group[0];
    if (group.length === 1 && first) {
      afterExact.push(first);
      continue;
    }
    const ordered = [...group].sort(compareKeeperPriority);
    const keeper = ordered[0];
    if (!keeper) continue;
    afterExact.push(keeper);
    for (const duplicate of ordered.slice(1)) absorb(keeper, duplicate);
  }

  // Trigram pass over exact-survivors, in canonical order for determinism.
  const grams = new Map<NormalizedItem, Set<string>>();
  for (const item of afterExact) grams.set(item, trigrams(normalizeTitleForMatch(item.title)));
  const ordered = [...afterExact].sort(compareKeeperPriority);
  const keepers: NormalizedItem[] = [];
  for (const candidate of ordered) {
    let target: NormalizedItem | null = null;
    for (const keeper of keepers) {
      const left = grams.get(candidate);
      const right = grams.get(keeper);
      if (left && right && jaccard(left, right) >= threshold) {
        target = keeper;
        break;
      }
    }
    if (target) absorb(target, candidate);
    else keepers.push(candidate);
  }

  // Emit keepers in input order for stable sheet output.
  const keeperSet = new Set(keepers);
  const mergedItems: MergedItem[] = [];
  for (const item of items) {
    if (!keeperSet.has(item)) continue;
    mergedItems.push({ ...item, merged_sources: [...(absorbedSourceLists.get(item) ?? [])] });
  }

  return {
    items: mergedItems,
    absorbedHashes: [...new Set(absorbed.map((entry) => entry.content_hash))],
    absorbed,
    absorbedByKeeper,
    kept: keepers.length,
    merged: items.length - keepers.length,
  };
}

// ── cross-day seen_items ────────────────────────────────────────────────────

export interface SeenFilter {
  fresh: NormalizedItem[];
  seenCount: number;
}

/** YYYY-MM-DD minus N days (UTC date math; ISO strings compare lexicographically). */
export function cutoffDate(runDate: string, dedupeDays: number): string {
  const year = Number(runDate.slice(0, 4));
  const month = Number(runDate.slice(5, 7));
  const day = Number(runDate.slice(8, 10));
  const cutoff = new Date(Date.UTC(year, month - 1, day) - dedupeDays * 86_400_000);
  return cutoff.toISOString().slice(0, 10);
}

/**
 * Drop items whose content_hash was last seen on/after the cutoff.
 * dedupeDays ≤ 0 disables cross-day filtering (within-run merge still applies).
 */
export function filterSeenItems(
  db: StateDb,
  items: NormalizedItem[],
  options: { runDate: string; dedupeDays: number },
): SeenFilter {
  if (options.dedupeDays <= 0) return { fresh: [...items], seenCount: 0 };
  const cutoff = cutoffDate(options.runDate, options.dedupeDays);
  const rows = db
    .prepare("SELECT content_hash FROM seen_items WHERE last_seen_date >= ?")
    .all(cutoff) as { content_hash: string }[];
  const seen = new Set(rows.map((row) => row.content_hash));
  const fresh = items.filter((item) => !seen.has(item.content_hash));
  return { fresh, seenCount: items.length - fresh.length };
}

/**
 * Record keeper + absorbed hashes AFTER the sheet append succeeds (TRD §6
 * stage 5). Upsert: first_seen_date keeps the original sighting,
 * last_seen_date always advances to this run.
 */
export const SEEN_UPSERT_SQL = `INSERT INTO seen_items (content_hash, first_seen_date, last_seen_date, source)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(content_hash) DO UPDATE SET last_seen_date = excluded.last_seen_date`;

/** Dedupe entries by hash (first source wins), shared by record/persist. */
export function uniqueSeenEntries(
  entries: { content_hash: string; source: SourceKey }[],
): Map<string, SourceKey> {
  const unique = new Map<string, SourceKey>();
  for (const entry of entries) {
    if (!unique.has(entry.content_hash)) unique.set(entry.content_hash, entry.source);
  }
  return unique;
}

export function recordSeenItems(
  db: StateDb,
  entries: { content_hash: string; source: SourceKey }[],
  runDate: string,
): { recorded: number } {
  const upsert = db.prepare(SEEN_UPSERT_SQL);
  const unique = uniqueSeenEntries(entries);
  const write = db.transaction(() => {
    for (const [content_hash, source] of unique) {
      upsert.run(content_hash, runDate, runDate, source);
    }
  });
  write();
  return { recorded: unique.size };
}
