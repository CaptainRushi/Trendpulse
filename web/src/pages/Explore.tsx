import type React from "react";
import { useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useSources, useTrends } from "../hooks/useApi";
import { useTopicFilters } from "../hooks/useFilters";
import type { SortedTopic } from "../lib/api";
import { EmptyState, ErrorState, SkeletonGrid } from "../components/States";
import { CategoryChip, MomentumBadge } from "../components/badges";
import { FilterBar } from "../components/FilterBar";
import { TopicCard } from "../components/TopicCard";
import { TopicDrawer } from "../components/TopicDrawer";
import { useTopicEvidence } from "../hooks/useApi";
import { shiftAppDate, todayAppDate } from "../lib/format";

/**
 * Explore (§5.3): any date + range, same filters, cards/table toggle,
 * compare mode (two dates: new / disappeared / rising).
 */
export function Explore(): React.JSX.Element {
  const [params, setParams] = useSearchParams();
  const [filters, updateFilters, clearFilters] = useTopicFilters();
  const [openTopic, setOpenTopic] = useState<SortedTopic | null>(null);
  const [view, setView] = useState<"cards" | "table">("cards");
  const [compare, setCompare] = useState("");
  const sources = useSources();
  const evidence = useTopicEvidence(openTopic?.topic_id ?? null);

  const date = params.get("date") ?? todayAppDate();
  const goDate = (next: string): void => {
    const nextParams = new URLSearchParams(params);
    nextParams.set("date", next);
    setParams(nextParams, { replace: true });
  };

  const query = {
    date,
    category: filters.category,
    source: filters.source,
    momentum: filters.momentum,
    sort: filters.sort,
    limit: 50,
    offset: 0,
    ...(filters.q ? { q: filters.q } : {}),
    ...(filters.minScore !== undefined ? { minScore: filters.minScore } : {}),
  };
  const current = useTrends(query);
  const other = useTrends({ ...query, date: compare });
  const compareActive = compare !== "" && compare !== date;

  const comparison = useMemo(() => {
    if (!compareActive || !current.data || !other.data) return null;
    const base = new Map(other.data.items.map((t) => [t.title, t]));
    const now = new Map(current.data.items.map((t) => [t.title, t]));
    const fresh = current.data.items.filter((t) => !base.has(t.title));
    const gone = other.data.items.filter((t) => !now.has(t.title));
    const rising = current.data.items.filter((t) => {
      const was = base.get(t.title);
      return was !== undefined && t.trend_score > was.trend_score + 10;
    });
    return { fresh, gone, rising };
  }, [compareActive, current.data, other.data]);

  return (
    <div className="page">
      <h1 style={{ margin: 0 }}>Explore</h1>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
        <button type="button" className="btn btn-ghost" aria-label="Previous day" onClick={() => { goDate(shiftAppDate(date, -1)); }}>‹</button>
        <input
          className="input"
          type="date"
          aria-label="Explore date"
          value={date}
          onChange={(event) => {
            if (event.target.value) goDate(event.target.value);
          }}
        />
        <button type="button" className="btn btn-ghost" aria-label="Next day" onClick={() => { goDate(shiftAppDate(date, 1)); }}>›</button>
        <label>
          View{" "}
          <select className="select" aria-label="View mode" value={view} onChange={(event) => { setView(event.target.value as "cards" | "table"); }}>
            <option value="cards">Cards</option>
            <option value="table">Table</option>
          </select>
        </label>
        <label>
          Compare with{" "}
          <input
            className="input"
            type="date"
            aria-label="Compare date"
            value={compare}
            onChange={(event) => { setCompare(event.target.value); }}
          />
        </label>
        {compareActive ? (
          <button type="button" className="btn btn-ghost" onClick={() => { setCompare(""); }}>
            Clear compare
          </button>
        ) : null}
      </div>

      <FilterBar
        filters={filters}
        onChange={updateFilters}
        onClear={clearFilters}
        sources={(sources.data ?? []).map((s) => ({ key: s.key, label: s.label }))}
      />

      {comparison ? (
        <section className="card" aria-label="Date comparison">
          <strong>
            vs {compare}: {comparison.fresh.length} new · {comparison.gone.length} disappeared · {comparison.rising.length} rising
          </strong>
          {comparison.fresh.slice(0, 5).map((t) => (
            <div key={t.topic_id}>+ {t.title}</div>
          ))}
        </section>
      ) : null}

      {current.isPending ? <SkeletonGrid /> : null}
      {current.isError ? <ErrorState error={current.error} /> : null}
      {current.data && current.data.items.length === 0 ? (
        <EmptyState title="No topics for this date" hint="Pick another date or clear filters." />
      ) : null}
      {current.data && current.data.items.length > 0 && view === "cards" ? (
        <div className="topic-grid">
          {current.data.items.map((topic) => (
            <TopicCard key={topic.topic_id} topic={topic} selected={false} onOpen={setOpenTopic} />
          ))}
        </div>
      ) : null}
      {current.data && current.data.items.length > 0 && view === "table" ? (
        <div className="card" style={{ overflowX: "auto" }}>
          <table className="data-table">
            <thead>
              <tr>
                <th scope="col">Rank</th>
                <th scope="col">Title</th>
                <th scope="col">Category</th>
                <th scope="col">Score</th>
                <th scope="col">Momentum</th>
                <th scope="col">Sources</th>
              </tr>
            </thead>
            <tbody>
              {current.data.items.map((topic) => (
                <tr key={topic.topic_id}>
                  <td>{topic.rank}</td>
                  <td>
                    <button type="button" className="btn btn-ghost" onClick={() => { setOpenTopic(topic); }}>
                      {topic.title}
                    </button>
                  </td>
                  <td><CategoryChip category={topic.category} /></td>
                  <td>{topic.trend_score}</td>
                  <td><MomentumBadge momentum={topic.momentum} /></td>
                  <td>{topic.source_count}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      {openTopic ? (
        <TopicDrawer
          topic={openTopic}
          evidence={evidence.data?.evidence ?? []}
          evidenceLoading={evidence.isPending}
          onClose={() => {
            setOpenTopic(null);
          }}
        />
      ) : null}
    </div>
  );
}
