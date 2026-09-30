import { createHash } from "node:crypto";

/** sha1 hex — the content_hash of TRD §6 stage 2 (canonical_url or normalized_title). */
export function sha1(input: string): string {
  return createHash("sha1").update(input, "utf8").digest("hex");
}

/**
 * Content identity for cross-day dedupe: canonical URL when we have one,
 * otherwise the normalized title (trimmed, lowercased, whitespace-collapsed).
 */
export function contentHash(canonicalUrl: string | null, title: string): string {
  if (canonicalUrl) return sha1(canonicalUrl);
  const normalizedTitle = title.trim().toLowerCase().replace(/\s+/g, " ");
  return sha1(normalizedTitle);
}
