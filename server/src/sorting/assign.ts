/**
 * Category assignment (Doc 19 Q3): every classified item lands in exactly
 * one of the run's categories, or is excluded (raw row kept, never
 * deleted). The 0.6 confidence boundary is inclusive on the upper side.
 */
export const ASSIGN_CONFIDENCE_MIN = 0.6;

export type Assignment = { category: string } | { excluded: "off_category" | "no_assignment" };

export function assignCategory(args: {
  /** Jev category label (e.g. "AI"); coerced to a slug for comparison. */
  label: string;
  confidence: number;
  /** Run's selected category slugs; empty = general run (keep the label). */
  selected: Set<string>;
  /** Category whose source found the item; null for sourceless stored rows. */
  target: string | null;
}): Assignment {
  const slug = args.label.trim().toLowerCase();
  if (args.selected.size === 0) return { category: slug };
  if (args.confidence >= ASSIGN_CONFIDENCE_MIN) {
    if (args.selected.has(slug)) return { category: slug };
    return { excluded: "off_category" };
  }
  if (args.target !== null && args.target !== "") return { category: args.target.trim().toLowerCase() };
  return { excluded: "no_assignment" };
}
