/**
 * Source refreshers (Doc 16 G2): hackernews + github over the shared polite
 * HttpClient (UA, per-domain gap, ETag, no retry — the sampler owns retry
 * policy via carry-forward and per-day 429 mutes). Reddit is OAuth-only and
 * returns skipped; anything else reports "no live metric".
 */
import type { StateDb } from "../db/sqlite.js";
import { HttpError, type EtagCacheStore, type HttpClient } from "../collectors/http.js";
import type { Refresher, RefreshItem, RefreshOutcome } from "./refresh.js";

export interface RefresherDeps {
  http: HttpClient;
  githubToken?: string;
}

/** SQLite-backed ETag store on the existing http_cache table. */
export function sqliteEtagStore(db: StateDb): EtagCacheStore {
  return {
    get: (url: string): Promise<{ etag: string | null; last_modified: string | null } | null> => {
      const row = db.prepare("SELECT etag, last_modified FROM http_cache WHERE url = ?").get(url) as {
        etag: string | null;
        last_modified: string | null;
      } | undefined;
      return Promise.resolve(row ? { etag: row.etag, last_modified: row.last_modified } : null);
    },
    set: (url: string, etag: string | null, lastModified: string | null): Promise<void> => {
      db.prepare(
        "INSERT INTO http_cache (url, etag, last_modified, fetched_at) VALUES (?, ?, ?, datetime('now')) " +
          "ON CONFLICT(url) DO UPDATE SET etag = excluded.etag, last_modified = excluded.last_modified, fetched_at = datetime('now')",
      ).run(url, etag, lastModified);
      return Promise.resolve();
    },
  };
}

function hnId(item: RefreshItem): string {
  if (/^\d+$/.test(item.sourceItemId)) return item.sourceItemId;
  const match = /[?&]id=(\d+)/.exec(item.url);
  return match?.[1] ?? "";
}

function fail(itemId: string, error: unknown): RefreshOutcome {
  if (error instanceof HttpError) {
    if (error.status === 429) return { itemId, error: `429 ${error.message}` };
    if (error.status === 404 || error.status === 410) return { itemId, error: "dead" };
    return { itemId, error: `${String(error.status)} ${error.message}` };
  }
  return { itemId, error: error instanceof Error ? error.message : String(error) };
}

export async function refreshHackernews(deps: RefresherDeps, items: RefreshItem[]): Promise<RefreshOutcome[]> {
  const out: RefreshOutcome[] = [];
  for (const item of items) {
    const id = hnId(item);
    if (id === "") {
      out.push({ itemId: item.itemId, skipped: "no live metric" });
      continue;
    }
    try {
      const res = await deps.http.get(`https://hacker-news.firebaseio.com/v0/item/${id}.json`, { timeoutMs: 15000 });
      const parsed = JSON.parse(res.text) as { score?: unknown; dead?: unknown; deleted?: unknown };
      if (parsed.dead === true || parsed.deleted === true) {
        out.push({ itemId: item.itemId, error: "dead" });
      } else if (typeof parsed.score === "number") {
        out.push({ itemId: item.itemId, value: parsed.score });
      } else {
        out.push({ itemId: item.itemId, error: "no score" });
      }
    } catch (error) {
      out.push(fail(item.itemId, error));
    }
  }
  return out;
}

function githubRepo(url: string): string {
  const match = /github\.com\/([^/]+\/[^/?#]+)/i.exec(url);
  if (!match?.[1]) return "";
  return match[1].replace(/\.(git)$/i, "").replace(/\/(tree|blob|pull|issues|actions)\/.*$/, "");
}

export async function refreshGithub(deps: RefresherDeps, items: RefreshItem[]): Promise<RefreshOutcome[]> {
  const out: RefreshOutcome[] = [];
  const headers: Record<string, string> = { Accept: "application/vnd.github+json" };
  if (deps.githubToken) headers.Authorization = `Bearer ${deps.githubToken}`;
  for (const item of items) {
    const repo = githubRepo(item.url);
    if (repo === "") {
      out.push({ itemId: item.itemId, skipped: "no live metric" });
      continue;
    }
    try {
      const res = await deps.http.get(`https://api.github.com/repos/${repo}`, { headers, timeoutMs: 15000, etag: true });
      if (res.notModified) {
        out.push({ itemId: item.itemId, unchanged: true });
        continue;
      }
      const parsed = JSON.parse(res.text) as { stargazers_count?: unknown };
      if (typeof parsed.stargazers_count === "number") {
        out.push({ itemId: item.itemId, value: parsed.stargazers_count });
      } else {
        out.push({ itemId: item.itemId, error: "no stars" });
      }
    } catch (error) {
      out.push(fail(item.itemId, error));
    }
  }
  return out;
}

const reddit: Refresher = {
  source: "reddit",
  canRefresh: (item) => item.source === "reddit",
  refresh: (items: RefreshItem[]): Promise<RefreshOutcome[]> =>
    Promise.resolve(items.map((item) => ({ itemId: item.itemId, skipped: "reddit needs OAuth" }))),
};

/** Ordered refreshers; the sampler falls back to "no live metric" otherwise. */
export function buildRefreshers(deps: RefresherDeps): Refresher[] {
  return [
    {
      source: "hackernews",
      canRefresh: (item) => item.source === "hackernews",
      refresh: (items) => refreshHackernews(deps, items),
    },
    {
      source: "github",
      canRefresh: (item) => item.source === "github",
      refresh: (items) => refreshGithub(deps, items),
    },
    reddit,
  ];
}
