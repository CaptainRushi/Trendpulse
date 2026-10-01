/**
 * Normalize stage (TRD §6 stage 2): collector drafts → normalized items.
 *
 * Pure functions, no DB, no network — fully deterministic for fixed input:
 * canonical URL (strip utm/fbclid, lowercase host, drop fragment), trim +
 * cap title (300) / snippet (500) per backend schema §3, strip HTML, detect
 * language (keep a valid provided code, else heuristic, else null — never a
 * guessed default), re-validate published dates (unparseable → null, never
 * throws), and `content_hash = sha1(canonical_url or normalized_title)`.
 */
import type { RawItemDraft } from "../collectors/types.js";
import type { SourceKey } from "../sheets/schema.js";
import { contentHash } from "../utils/hash.js";
import { toIsoOrNull } from "../utils/time.js";
import { canonicalizeUrl } from "../utils/url.js";

/** Backend schema §3 caps: title ≤ 300, snippet ≤ 500 (sheets cells cap 2000). */
export const MAX_TITLE_LENGTH = 300;
export const MAX_SNIPPET_LENGTH = 500;

/** Normalized draft: everything RawTrendRecord needs except id/run/timing/norm. */
export interface NormalizedItem {
  source: SourceKey;
  source_item_id: string | null;
  url: string;
  title: string;
  snippet: string;
  author: string | null;
  published_at: string | null;
  engagement_score: number | null;
  engagement: Record<string, number>;
  language: string | null;
  region: string | null;
  content_hash: string;
  extraction_model: string | null;
}

export interface NormalizeStats {
  input: number;
  output: number;
  droppedBadUrl: number;
  droppedEmptyTitle: number;
}

export interface NormalizeResult {
  items: NormalizedItem[];
  stats: NormalizeStats;
}

const HTML_TAG = /<[^>]*>/g;
const ENTITY_MAP: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

/** Strip tags, decode common entities, collapse whitespace. Deterministic. */
export function cleanText(raw: string): string {
  const noTags = raw.replace(HTML_TAG, " ");
  const decoded = noTags.replace(/&(#\d+|#x[0-9a-fA-F]+|[a-zA-Z]+);/g, (match, body: string) => {
    if (body.startsWith("#x") || body.startsWith("#X")) {
      const code = Number.parseInt(body.slice(2), 16);
      return Number.isNaN(code) ? match : String.fromCodePoint(code);
    }
    if (body.startsWith("#")) {
      const code = Number.parseInt(body.slice(1), 10);
      return Number.isNaN(code) ? match : String.fromCodePoint(code);
    }
    return ENTITY_MAP[body] ?? match;
  });
  return decoded.replace(/\s+/g, " ").trim();
}

function emptyToNull(value: string): string | null {
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

// ── language detection (heuristic, no dependencies) ─────────────────────────

/** [start, end, language] — dominant non-Latin script wins (approximation). */
const SCRIPT_RANGES: { start: number; end: number; language: string }[] = [
  { start: 0x0400, end: 0x04ff, language: "ru" }, // Cyrillic (ru/uk/bg/sr — reported as ru)
  { start: 0x0600, end: 0x06ff, language: "ar" }, // Arabic
  { start: 0x0590, end: 0x05ff, language: "he" }, // Hebrew
  { start: 0x0370, end: 0x03ff, language: "el" }, // Greek
  { start: 0x0e00, end: 0x0e7f, language: "th" }, // Thai
  { start: 0x0900, end: 0x097f, language: "hi" }, // Devanagari
  { start: 0x4e00, end: 0x9fff, language: "zh" }, // CJK ideographs (no kana → zh)
  { start: 0x3040, end: 0x30ff, language: "ja" }, // Hiragana + Katakana
  { start: 0xac00, end: 0xd7af, language: "ko" }, // Hangul
];

const STOPWORDS: Record<string, string[]> = {
  en: ["the", "and", "of", "to", "in", "is", "you", "that", "it", "was", "for", "on", "are", "with", "this"],
  es: ["de", "la", "que", "el", "en", "los", "se", "del", "las", "un", "por", "con", "para", "es", "una"],
  fr: ["de", "la", "le", "et", "les", "des", "en", "un", "du", "une", "est", "que", "pour", "dans", "qui"],
  de: ["der", "die", "und", "in", "den", "von", "zu", "das", "mit", "sich", "des", "auf", "ist", "im", "dem"],
  pt: ["de", "que", "do", "da", "em", "um", "para", "com", "uma", "os", "no", "na", "se", "nas", "dos"],
  it: ["di", "da", "in", "con", "su", "per", "tra", "fra", "il", "lo", "la", "gli", "che", "una", "del"],
  nl: ["de", "van", "een", "het", "en", "in", "op", "dat", "die", "voor", "met", "als", "zijn", "aan", "door"],
};

/** Winner needs ≥2 hits and a strict lead; ties/unknown → null (never guess). */
const MIN_STOPWORD_HITS = 2;
/** A script claims the text when it holds ≥30% of all letters. */
const SCRIPT_SHARE_THRESHOLD = 0.3;

function detectScriptLanguage(text: string): string | null {
  const counts = new Map<string, number>();
  let letters = 0;
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    const isLetter = /[\p{L}]/u.test(char);
    if (!isLetter) continue;
    letters += 1;
    for (const range of SCRIPT_RANGES) {
      if (code >= range.start && code <= range.end) {
        counts.set(range.language, (counts.get(range.language) ?? 0) + 1);
        break;
      }
    }
  }
  if (letters === 0) return null;
  let best: string | null = null;
  let bestCount = 0;
  for (const [language, count] of counts) {
    if (count > bestCount) {
      best = language;
      bestCount = count;
    }
  }
  if (best === null || bestCount / letters < SCRIPT_SHARE_THRESHOLD) return null;
  return best;
}

function detectStopwordLanguage(text: string): string | null {
  const tokens = text.toLowerCase().split(/[^a-zà-ÿâêîôûäöüßñç]+/i).filter((t) => t.length > 0);
  if (tokens.length === 0) return null;
  const tokenSet = new Set(tokens);
  let best: string | null = null;
  let bestScore = 0;
  let secondScore = 0;
  for (const [language, words] of Object.entries(STOPWORDS)) {
    let score = 0;
    for (const word of words) if (tokenSet.has(word)) score += 1;
    if (score > bestScore) {
      secondScore = bestScore;
      best = language;
      bestScore = score;
    } else if (score > secondScore) {
      secondScore = score;
    }
  }
  if (best === null || bestScore < MIN_STOPWORD_HITS || bestScore === secondScore) return null;
  return best;
}

/**
 * Keep a valid provided ISO 639-1 code; else script heuristic, else stopword
 * scoring, else null. Ties and thin evidence → null, never a guessed default.
 */
export function detectLanguage(provided: string | null, title: string, snippet: string): string | null {
  if (provided !== null && /^[a-z]{2}$/i.test(provided.trim())) {
    return provided.trim().toLowerCase();
  }
  const text = `${title} ${snippet}`;
  return detectScriptLanguage(text) ?? detectStopwordLanguage(text);
}

// ── draft → normalized ──────────────────────────────────────────────────────

export type DropReason = "bad-url" | "empty-title";

function normalizeOne(draft: RawItemDraft): { item: NormalizedItem } | { drop: DropReason } {
  const url = canonicalizeUrl(draft.url);
  if (url === null) return { drop: "bad-url" };
  const title = cleanText(draft.title).slice(0, MAX_TITLE_LENGTH);
  if (title === "") return { drop: "empty-title" };
  const snippet = cleanText(draft.snippet).slice(0, MAX_SNIPPET_LENGTH);
  return {
    item: {
      source: draft.source,
      source_item_id: draft.source_item_id,
      url,
      title,
      snippet,
      author: draft.author === null ? null : emptyToNull(draft.author),
      published_at: toIsoOrNull(draft.published_at),
      engagement_score: draft.engagement_score,
      engagement: draft.engagement,
      language: detectLanguage(draft.language, title, snippet),
      region: draft.region === null ? null : emptyToNull(draft.region),
      content_hash: contentHash(url, title),
      extraction_model: draft.extraction_model,
    },
  };
}

export function normalizeDrafts(drafts: RawItemDraft[]): NormalizeResult {
  const items: NormalizedItem[] = [];
  let droppedBadUrl = 0;
  let droppedEmptyTitle = 0;
  for (const draft of drafts) {
    const result = normalizeOne(draft);
    if ("drop" in result) {
      if (result.drop === "bad-url") droppedBadUrl += 1;
      else droppedEmptyTitle += 1;
    } else {
      items.push(result.item);
    }
  }
  return {
    items,
    stats: { input: drafts.length, output: items.length, droppedBadUrl, droppedEmptyTitle },
  };
}

// ── engagement_norm (TRD §6 stage 4) ────────────────────────────────────────

export interface ScoredItem extends NormalizedItem {
  /** 0..1 within this run (percentile per source, or position fallback). */
  engagement_norm: number;
}

/**
 * Per source, percentile rank of engagement inside this run → 0..1.
 * Scored items (engagement_score ≠ null) get the mid-rank percentile among
 * scored peers (ties share the average rank); unscored items — and sources
 * with no scores at all — fall back to position `1 - pos/N` in first-seen
 * order. Single-item groups score 1.0. Deterministic for fixed input.
 */
export function applyEngagementNorm<T extends NormalizedItem>(
  items: T[],
): (T & { engagement_norm: number })[] {
  const groups = new Map<SourceKey, { item: NormalizedItem; index: number }[]>();
  items.forEach((item, index) => {
    const group = groups.get(item.source);
    if (group) group.push({ item, index });
    else groups.set(item.source, [{ item, index }]);
  });

  const norms = new Array<number>(items.length).fill(0);
  for (const group of groups.values()) {
    const scored = group.filter((entry) => entry.item.engagement_score !== null);
    if (scored.length === 0) {
      group.forEach((entry, pos) => {
        norms[entry.index] = 1 - pos / group.length;
      });
      continue;
    }
    if (scored.length === 1) {
      const only = scored[0];
      if (only) norms[only.index] = 1;
    } else {
      const values = scored.map((entry) => entry.item.engagement_score as number).sort((a, b) => a - b);
      for (const entry of scored) {
        const value = entry.item.engagement_score as number;
        let below = 0;
        let equal = 0;
        for (const other of values) {
          if (other < value) below += 1;
          else if (other === value) equal += 1;
        }
        // Mid-rank percentile: strictly-below + half the ties (excl. self).
        const rank = below + (equal - 1) / 2;
        norms[entry.index] = rank / (values.length - 1);
      }
    }
    // Unscored members of a partially-scored source: position fallback.
    group.forEach((entry, pos) => {
      if (entry.item.engagement_score === null) {
        norms[entry.index] = 1 - pos / group.length;
      }
    });
  }
  return items.map((item, index) => ({ ...item, engagement_norm: norms[index] ?? 0 }));
}
