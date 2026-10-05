/**
 * Category registry (Doc 17 S1): per-category extra sources for targeted
 * runs. Every default below was verified live on 2026-10-05 (HTTP 200 with
 * items; dropped: nature/HTML-not-RSS, nih/403, MNT/404, WHO/404, arXiv
 * cs.AI valid-but-empty). At most 3 defaults per category; users override
 * via the `category_sources` settings key (validated here).
 */
import { z } from "zod";

export const CATEGORY_SLUGS = [
  "tech",
  "ai",
  "business",
  "finance",
  "science",
  "health",
  "politics",
  "world",
  "sports",
  "entertainment",
  "culture",
  "gaming",
  "lifestyle",
  "other",
] as const;

export type CategorySlug = (typeof CATEGORY_SLUGS)[number];

const CategorySource = z.object({
  collector: z.enum(["hackernews", "github", "rss", "reddit"]),
  params: z
    .object({
      keywords: z.array(z.string().min(1)).max(5).optional(),
      query: z.string().min(1).optional(),
      feeds: z.array(z.string().url()).max(5).optional(),
      subreddits: z.array(z.string().min(1)).max(5).optional(),
    })
    .default({}),
  verified_at: z.string().default(""),
});
export type CategorySource = z.infer<typeof CategorySource>;

const CategoryEntry = z.object({
  slug: z.string(),
  label: z.string(),
  sources: z.array(CategorySource).max(3),
});
export type CategoryEntry = z.infer<typeof CategoryEntry>;

const V = "2026-10-05";

function hn(keywords: string[]): CategorySource {
  return { collector: "hackernews", params: { keywords }, verified_at: V };
}
function gh(query: string): CategorySource {
  return { collector: "github", params: { query }, verified_at: V };
}
function rss(...feeds: string[]): CategorySource {
  return { collector: "rss", params: { feeds }, verified_at: V };
}

export const CATEGORY_REGISTRY: Record<string, CategoryEntry> = {
  tech: {
    slug: "tech",
    label: "Tech",
    sources: [
      hn(["open source", "programming", "developer tools"]),
      gh("topic:open-source"),
      rss("https://lobste.rs/rss", "https://feeds.bbci.co.uk/news/technology/rss.xml"),
    ],
  },
  ai: {
    slug: "ai",
    label: "AI",
    sources: [
      hn(["llm", "ai agent", "openai"]),
      gh("topic:llm"),
      rss("https://www.technologyreview.com/feed/"),
    ],
  },
  business: {
    slug: "business",
    label: "Business",
    sources: [hn(["startup", "funding"]), rss("https://feeds.marketwatch.com/marketwatch/topstories/", "https://www.cnbc.com/id/100003114/device/rss/rss.html")],
  },
  finance: {
    slug: "finance",
    label: "Finance",
    sources: [hn(["stocks", "markets"]), rss("https://feeds.marketwatch.com/marketwatch/topstories/", "https://www.coindesk.com/arc/outboundfeeds/rss/")],
  },
  science: {
    slug: "science",
    label: "Science",
    sources: [hn(["science", "space"]), rss("https://www.sciencedaily.com/rss/all.xml", "https://www.theguardian.com/science/rss")],
  },
  health: {
    slug: "health",
    label: "Health",
    sources: [hn(["health", "fitness"]), rss("https://www.statnews.com/feed/")],
  },
  politics: {
    slug: "politics",
    label: "Politics",
    sources: [hn(["election", "policy"]), rss("https://feeds.npr.org/1001/rss.xml", "https://thehill.com/feed/")],
  },
  world: {
    slug: "world",
    label: "World",
    sources: [hn(["world", "climate"]), rss("https://feeds.bbci.co.uk/news/world/rss.xml")],
  },
  sports: {
    slug: "sports",
    label: "Sports",
    sources: [hn(["sports", "olympics"]), rss("https://www.espn.com/espn/rss/news", "https://feeds.bbci.co.uk/sport/rss.xml")],
  },
  entertainment: {
    slug: "entertainment",
    label: "Entertainment",
    sources: [hn(["movie", "music"]), rss("https://variety.com/feed/")],
  },
  culture: {
    slug: "culture",
    label: "Culture",
    sources: [hn(["art", "books"]), rss("https://www.theguardian.com/culture/rss")],
  },
  gaming: {
    slug: "gaming",
    label: "Gaming",
    sources: [hn(["video games", "nintendo"]), gh("topic:game"), rss("https://www.polygon.com/rss/index.xml")],
  },
  lifestyle: {
    slug: "lifestyle",
    label: "Lifestyle",
    sources: [hn(["travel", "food"]), rss("https://www.theguardian.com/lifeandstyle/rss")],
  },
  // `other` is the unclassifiable bucket: no extra sources by design. A scope
  // of only `other` reuses stored items and collects nothing new.
  other: { slug: "other", label: "Other", sources: [] },
};

/** Scope key: "all", or slugs sorted alphabetically joined with "+" (max 5). */
export function normalizeScope(slugs: string[]): string {
  const clean = [...new Set(slugs.map((s) => s.trim().toLowerCase()).filter((s) => s !== ""))].sort();
  if (clean.length === 0) return "all";
  if (clean.length === 1 && clean[0] === "all") return "all";
  if (clean.length > 5) throw new Error("at most 5 categories per scope");
  const unknown = clean.filter((s) => !(CATEGORY_SLUGS as readonly string[]).includes(s));
  if (unknown.length > 0) throw new Error(`unknown categories: ${unknown.join(", ")}`);
  return clean.join("+");
}

/** Effective sources: registry defaults overlaid with user overrides. */
export function effectiveSources(
  slug: string,
  overrides: Record<string, CategorySource[]> = {},
): CategorySource[] {
  const found: CategorySource[] | undefined = overrides[slug];
  if (found !== undefined) return found;
  return CATEGORY_REGISTRY[slug]?.sources ?? [];
}

/** Validate the `category_sources` settings value (slug → sources). */
export function validateCategorySources(raw: unknown): Record<string, CategorySource[]> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error("expected an object of slug to sources");
  }
  const out: Record<string, CategorySource[]> = {};
  for (const [slug, sources] of Object.entries(raw as Record<string, unknown>)) {
    if (!(CATEGORY_SLUGS as readonly string[]).includes(slug)) {
      throw new Error(`unknown category '${slug}'`);
    }
    if (!Array.isArray(sources) || sources.length > 3) {
      throw new Error(`category '${slug}': expected 1-3 sources`);
    }
    out[slug] = sources.map((source, i) => {
      const parsed = CategorySource.safeParse(source);
      if (!parsed.success) {
        throw new Error(`category '${slug}' source ${String(i)}: ${parsed.error.issues[0]?.message ?? "invalid"}`);
      }
      return { ...parsed.data, verified_at: "" };
    });
  }
  return out;
}
