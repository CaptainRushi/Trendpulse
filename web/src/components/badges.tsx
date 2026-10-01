import type React from "react";
import { categoryColor, momentumMeta } from "../lib/format";

/** Momentum badge: icon + label (color never the only carrier, §9). */
export function MomentumBadge({ momentum }: { momentum: string }): React.JSX.Element {
  const meta = momentumMeta(momentum);
  return (
    <span className="badge" data-tone={meta.tone} aria-label={`Momentum: ${meta.label}`}>
      <span aria-hidden="true">{meta.icon}</span> {meta.label}
    </span>
  );
}

export function CategoryChip({ category }: { category: string }): React.JSX.Element {
  return (
    <span className="cat-chip" style={{ ["--cat" as string]: categoryColor(category) }}>
      {category}
    </span>
  );
}

export function StatusPill({ status }: { status: string }): React.JSX.Element {
  const tone =
    status === "success" || status === "ok" || status === "done"
      ? "good"
      : status === "partial" || status === "running"
        ? "warn"
        : status === "failed" || status === "error"
          ? "bad"
          : status === "new" || status === "queued" || status === "pending"
            ? "info"
            : "";
  return (
    <span className="pill" data-tone={tone || undefined}>
      <span className="dot" aria-hidden="true" /> {status}
    </span>
  );
}
