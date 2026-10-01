import type React from "react";
import type { TopicFilters } from "../hooks/useFilters";

const CATEGORIES = ["Tech", "AI", "Business", "Science", "Health", "Politics", "World", "Sports", "Entertainment", "Culture", "Gaming", "Lifestyle", "Other"];
const MOMENTUMS = ["new", "rising", "peak", "steady", "fading"];

/** Filter bar (§5.1): category/source chips, momentum, min-score, search, sort. */
export function FilterBar({
  filters,
  onChange,
  onClear,
  sources,
}: {
  filters: TopicFilters;
  onChange: (next: Partial<TopicFilters>) => void;
  onClear: () => void;
  sources: { key: string; label: string }[];
}): React.JSX.Element {
  const toggle = (list: string[], value: string): string[] =>
    list.includes(value) ? list.filter((v) => v !== value) : [...list, value];

  return (
    <div role="search" aria-label="Topic filters" style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        {CATEGORIES.map((category) => (
          <button
            key={category}
            type="button"
            className="chip"
            aria-pressed={filters.category.includes(category)}
            onClick={() => {
              onChange({ category: toggle(filters.category, category) });
            }}
          >
            {category}
          </button>
        ))}
      </div>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
        <label>
          Source{" "}
          <select
            className="select"
            aria-label="Source filter"
            value={filters.source[0] ?? ""}
            onChange={(event) => {
              onChange({ source: event.target.value ? [event.target.value] : [] });
            }}
          >
            <option value="">All sources</option>
            {sources.map((s) => (
              <option key={s.key} value={s.key}>
                {s.label}
              </option>
            ))}
          </select>
        </label>
        <label>
          Momentum{" "}
          <select
            className="select"
            aria-label="Momentum filter"
            value={filters.momentum[0] ?? ""}
            onChange={(event) => {
              onChange({ momentum: event.target.value ? [event.target.value] : [] });
            }}
          >
            <option value="">Any</option>
            {MOMENTUMS.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
        </label>
        <label>
          Min score{" "}
          <input
            className="input"
            type="number"
            min={0}
            max={100}
            style={{ width: 80 }}
            aria-label="Minimum score"
            value={filters.minScore ?? ""}
            onChange={(event) => {
              onChange({ minScore: event.target.value === "" ? undefined : Number(event.target.value) });
            }}
          />
        </label>
        <label>
          Sort{" "}
          <select
            className="select"
            aria-label="Sort order"
            value={filters.sort}
            onChange={(event) => {
              onChange({ sort: event.target.value });
            }}
          >
            <option value="score">Score</option>
            <option value="rank">Rank</option>
            <option value="title">Title</option>
          </select>
        </label>
        {(filters.category.length > 0 || filters.source.length > 0 || filters.momentum.length > 0 || filters.q !== "" || filters.minScore !== undefined) && (
          <button type="button" className="btn btn-ghost" onClick={onClear}>
            Clear filters
          </button>
        )}
      </div>
    </div>
  );
}
