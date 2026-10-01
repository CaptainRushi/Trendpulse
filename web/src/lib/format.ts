/** Display helpers: momentum meta, score bands, dates, durations. */

export const MOMENTUM_META: Record<string, { icon: string; label: string; tone: string }> = {
  new: { icon: "●", label: "new", tone: "info" },
  rising: { icon: "▲", label: "rising", tone: "good" },
  peak: { icon: "◆", label: "peak", tone: "warn" },
  steady: { icon: "─", label: "steady", tone: "" },
  fading: { icon: "▼", label: "fading", tone: "bad" },
};

export function momentumMeta(momentum: string): { icon: string; label: string; tone: string } {
  return MOMENTUM_META[momentum] ?? { icon: "•", label: momentum, tone: "" };
}

/** Score ring band color (§4): 0–39 dim, 40–69 info, 70–84 brand, 85–100 good. */
export function scoreColor(score: number): string {
  if (score >= 85) return "var(--score-top)";
  if (score >= 70) return "var(--score-high)";
  if (score >= 40) return "var(--score-mid)";
  return "var(--score-low)";
}

const CATEGORY_HUES: Record<string, string> = {
  Tech: "var(--cat-tech)",
  AI: "var(--cat-ai)",
  Business: "var(--cat-business)",
  Finance: "var(--cat-finance)",
  Science: "var(--cat-science)",
  Health: "var(--cat-health)",
  Politics: "var(--cat-politics)",
  World: "var(--cat-world)",
  Sports: "var(--cat-sports)",
  Entertainment: "var(--cat-entertainment)",
  Culture: "var(--cat-culture)",
  Gaming: "var(--cat-gaming)",
  Lifestyle: "var(--cat-lifestyle)",
  Other: "var(--cat-other)",
};

export function categoryColor(category: string): string {
  return CATEGORY_HUES[category] ?? "var(--cat-other)";
}

export function formatDateTime(iso: string | null): string {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function formatDurationMs(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return "—";
  if (ms < 1000) return `${String(ms)}ms`;
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${String(seconds)}s`;
  return `${String(Math.floor(seconds / 60))}m ${String(seconds % 60)}s`;
}

export function todayAppDate(): string {
  return new Date().toLocaleDateString("en-CA");
}

export function shiftAppDate(date: string, days: number): string {
  const ms =
    Date.UTC(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10))) +
    days * 86_400_000;
  return new Date(ms).toISOString().slice(0, 10);
}
