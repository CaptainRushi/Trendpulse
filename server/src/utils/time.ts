/**
 * Shared date helpers for collectors (draft stage: dates must never throw —
 * an unparseable date degrades to null, not a failed source).
 */

/** RFC-2822 / ISO date string → ISO 8601, null when unparseable. */
export function toIsoOrNull(raw: string | undefined | null): string | null {
  if (!raw) return null;
  const ms = Date.parse(raw);
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

/** Unix seconds → ISO 8601, null for falsy input. */
export function epochSecondsToIso(seconds: number | undefined): string | null {
  if (!seconds) return null;
  return new Date(seconds * 1000).toISOString();
}
