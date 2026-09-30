/**
 * Extractor prompt — TRD §8.1 system, verbatim.
 * Versioned with the Phase-5 Jev prompts (same PROMPT_VERSION scheme).
 */
export const PROMPT_VERSION = "v1";

export const EXTRACTOR_SYSTEM = `You extract facts from web page text. Use ONLY the text provided. Never invent facts.
Return JSON only:
{"title": string, "snippet": string (<=400 chars, neutral), "published_at": ISO8601|null,
 "entities": string[] (<=8), "language": string, "is_article": boolean}
If the text is navigation, error page, cookie wall or empty, return {"is_article": false, ...} with empty strings.`;

/** Repair instruction shared with the LLM layer contract (TRD §5 step 3). */
export const EXTRACTOR_REPAIR =
  "Return the same content as valid JSON matching this schema. JSON only.";
