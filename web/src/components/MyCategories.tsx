/**
 * My-categories chip row (Doc 19 Q5): the ordered selection driving
 * collection, sorting and the Today panels. Add (remaining), remove (x),
 * keyboard reorder (move left/right). Every change saves immediately.
 */
import { useState } from "react";
import type React from "react";

export const ALL_CATEGORY_SLUGS = [
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
];

function move(list: string[], slug: string, delta: -1 | 1): string[] {
  const from = list.indexOf(slug);
  const to = from + delta;
  if (from < 0 || to < 0 || to >= list.length) return list;
  const next = [...list];
  const a = next[from];
  const b = next[to];
  if (a === undefined || b === undefined) return list;
  next[from] = b;
  next[to] = a;
  return next;
}

export function MyCategories({
  my,
  max,
  saving,
  onSave,
  onRunCategory,
}: {
  my: string[];
  max: number;
  saving: boolean;
  onSave: (next: string[]) => void;
  onRunCategory?: ((slug: string) => void) | undefined;
}): React.JSX.Element {
  const [lastAdded, setLastAdded] = useState<string | null>(null);
  const remaining = ALL_CATEGORY_SLUGS.filter((slug) => !my.includes(slug));

  const add = (slug: string): void => {
    if (slug === "" || my.includes(slug) || my.length >= max) return;
    onSave([...my, slug]);
    setLastAdded(slug);
  };

  const remove = (slug: string): void => {
    if (lastAdded === slug) setLastAdded(null);
    onSave(my.filter((s) => s !== slug));
  };

  return (
    <div>
      <div className="chip-row" role="group" aria-label="my categories">
        <span className="mono" aria-hidden="true">today · my categories:</span>
        {my.map((slug, index) => (
          <span key={slug} className="chip" data-active>
            {slug}
            <button type="button" className="chip-btn" aria-label={`move ${slug} left`} disabled={saving || index === 0} onClick={() => { onSave(move(my, slug, -1)); }}>
              ‹
            </button>
            <button type="button" className="chip-btn" aria-label={`move ${slug} right`} disabled={saving || index === my.length - 1} onClick={() => { onSave(move(my, slug, 1)); }}>
              ›
            </button>
            <button type="button" className="chip-btn" aria-label={`remove ${slug}`} disabled={saving} onClick={() => { remove(slug); }}>
              ×
            </button>
          </span>
        ))}
        {remaining.length > 0 && my.length < max ? (
          <select
            className="select"
            aria-label="add a category"
            value=""
            disabled={saving}
            onChange={(event) => {
              add(event.target.value);
            }}
          >
            <option value="">+ add</option>
            {remaining.map((slug) => (
              <option key={slug} value={slug}>
                {slug}
              </option>
            ))}
          </select>
        ) : null}
      </div>
      {lastAdded !== null && my.includes(lastAdded) && onRunCategory ? (
        <p className="form-hint">
          {lastAdded} added ·{" "}
          <button type="button" className="btn btn-ghost" onClick={() => { onRunCategory(lastAdded); }}>
            run for {lastAdded} now
          </button>
        </p>
      ) : null}
    </div>
  );
}
