/**
 * URL canonicalization (TRD §6 stage 2: strip utm/fbclid, lowercase host, drop fragment).
 * Used by collectors at draft time and by normalize for content_hash.
 */

/** Tracking params stripped on sight; everything else (except the fragment) is kept. */
const TRACKING_PARAMS = new Set([
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_term",
  "utm_content",
  "utm_id",
  "fbclid",
  "gclid",
  "dclid",
  "msclkid",
  "igshid",
  "mc_cid",
  "mc_eid",
  "ref_src",
  "ref_url",
]);

/**
 * Canonical form of a URL for hashing and cross-source dedupe:
 * absolute http(s) only, lowercase scheme+host, no fragment, tracking params removed.
 * Returns null when the input is not a valid http(s) URL.
 */
export function canonicalizeUrl(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;

  url.hash = "";
  url.hostname = url.hostname.toLowerCase();
  url.protocol = url.protocol.toLowerCase();

  const keep = [...url.searchParams.entries()].filter(([key]) => !TRACKING_PARAMS.has(key.toLowerCase()));
  // Sort remaining params so ?b=2&a=1 and ?a=1&b=2 canonicalize identically.
  keep.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  url.search = "";
  for (const [key, value] of keep) url.searchParams.append(key, value);

  // Trailing slash on non-root paths is insignificant (example.com/a/ == example.com/a).
  if (url.pathname.length > 1 && url.pathname.endsWith("/")) {
    url.pathname = url.pathname.slice(0, -1);
  }

  const out = url.toString();
  // URL.toString() adds "/" for bare hosts — keep it (that IS the root path).
  return out;
}
