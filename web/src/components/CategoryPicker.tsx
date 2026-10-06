/**
 * CategoryPicker (Doc 17 S5): multi-select chips (max 5), strict/loose
 * toggle, estimate popover, run button. Selection lives in the URL (?scope=).
 */
import { useState } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api";
import { useEstimate } from "../hooks/useLive";

export interface CategoryInfo {
  slug: string;
  label: string;
}

export function useCategories(): CategoryInfo[] {
  const query = useQuery({
    queryKey: ["categories"],
    queryFn: () =>
      api.get<{ categories: { slug: string; label: string }[] }>(`/api/categories`).then((r) => r.categories),
    staleTime: 5 * 60_000,
    retry: false,
  });
  return query.data ?? [];
}

interface PickerProps {
  selected: string[];
  mode: "strict" | "loose";
  onChange: (selected: string[], mode: "strict" | "loose") => void;
  onRun: () => void;
  running: boolean;
}

export function CategoryPicker({ selected, mode, onChange, onRun, running }: PickerProps): React.JSX.Element {
  const categories = useCategories();
  const [showEstimate, setShowEstimate] = useState(false);
  const estimate = useEstimate(selected, mode);
  const scope = [...selected].sort().join("+");

  const toggle = (slug: string): void => {
    if (selected.includes(slug)) {
      onChange(selected.filter((s) => s !== slug), mode);
    } else if (selected.length < 5) {
      onChange([...selected, slug], mode);
    }
  };

  return (
    <section aria-label="Category scope">
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <span className="mono" aria-label="Scope">scope:</span>
        <button
          type="button"
          className="chip"
          data-active={selected.length === 0 || undefined}
          onClick={() => {
            onChange([], mode);
          }}
        >
          all
        </button>
        {categories.map((c) => (
          <button
            key={c.slug}
            type="button"
            className="chip"
            data-active={selected.includes(c.slug) || undefined}
            aria-pressed={selected.includes(c.slug)}
            onClick={() => {
              toggle(c.slug);
            }}
          >
            {c.label.toLowerCase()}
            {selected.includes(c.slug) ? " ×" : ""}
          </button>
        ))}
        <Link className="btn btn-ghost" to="/settings">
          default categories ⚙
        </Link>
      </div>
      {selected.length > 0 ? (
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", marginTop: 8 }}>
          <div role="group" aria-label="Focus mode">
            <button
              type="button"
              className="chip"
              data-active={mode === "strict" || undefined}
              onClick={() => {
                onChange(selected, "strict");
              }}
            >
              strict
            </button>
            <button
              type="button"
              className="chip"
              data-active={mode === "loose" || undefined}
              onClick={() => {
                onChange(selected, "loose");
              }}
            >
              loose
            </button>
          </div>
          <button type="button" className="btn btn-ghost" onClick={() => { setShowEstimate((v) => !v); }} aria-expanded={showEstimate}>
            estimate
          </button>
          <button type="button" className="btn btn-primary" disabled={running} onClick={onRun}>
            {running ? "starting…" : `run for ${scope.split("+").join(" + ")}`}
          </button>
        </div>
      ) : null}
      {showEstimate && selected.length > 0 ? (
        <div className="panel" role="status" aria-label="Run estimate" style={{ marginTop: 8 }}>
          {estimate.isPending ? <span className="form-hint">estimating…</span> : null}
          {estimate.data ? (
            <span className="form-hint">
              ≈ {estimate.data.sources.length} new sources · ≈ {estimate.data.expected_new_items} new items · ≈ ${estimate.data.cost_usd_estimate.toFixed(4)} ·{" "}
              {estimate.data.stored_items_reused} stored reused
              {estimate.data.warnings.map((w) => ` · ${w}`).join("")}
            </span>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
