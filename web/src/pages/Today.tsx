import type React from "react";
import { useCallback, useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useDigest, useSources, useTopicEvidence, useTrends } from "../hooks/useApi";
import { useTopicFilters } from "../hooks/useFilters";
import type { SortedTopic } from "../lib/api";
import { todayAppDate } from "../lib/format";
import { useToast } from "../components/Toast";
import { DigestCard } from "../components/DigestCard";
import { FilterBar } from "../components/FilterBar";
import { EmptyState, ErrorState, SkeletonGrid } from "../components/States";
import { TopicCard } from "../components/TopicCard";
import { TopicDrawer } from "../components/TopicDrawer";

/**
 * Today (§5.1): digest + filters + topic cards + drawer. Answer first —
 * the ranked list renders with zero clicks. Keyboard: j/k move, Enter
 * opens, / focuses search.
 */
export function Today(): React.JSX.Element {
  const [searchParams] = useSearchParams();
  const date = searchParams.get("date") ?? todayAppDate();
  const [filters, updateFilters, clearFilters] = useTopicFilters();
  const [openTopic, setOpenTopic] = useState<SortedTopic | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const toast = useToast();

  const trends = useTrends({
    date,
    category: filters.category,
    source: filters.source,
    momentum: filters.momentum,
    sort: filters.sort,
    limit: 50,
    offset: 0,
    ...(filters.q ? { q: filters.q } : {}),
    ...(filters.minScore !== undefined ? { minScore: filters.minScore } : {}),
  });
  const digest = useDigest(date);
  const sources = useSources();
  const evidence = useTopicEvidence(openTopic?.topic_id ?? null);

  const items = trends.data?.items ?? [];
  const filterKey = [date, filters.q, filters.category.join(","), filters.source.join(","), filters.momentum.join(","), filters.minScore ?? "", filters.sort].join("|");

  const selectNeighbor = useCallback(
    (direction: 1 | -1) => {
      if (items.length === 0) return;
      const index = items.findIndex((item) => item.topic_id === selectedId);
      const next = items[(index + direction + items.length) % items.length];
      if (next) {
        setSelectedId(next.topic_id);
        document
          .querySelector(`[data-topic-id="${next.topic_id}"]`)
          ?.scrollIntoView({ block: "nearest" });
      }
    },
    [items, selectedId],
  );

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      const target = event.target as HTMLElement | null;
      const typing =
        target &&
        (target.tagName === "INPUT" || target.tagName === "SELECT" || target.tagName === "TEXTAREA");
      if (event.key === "/" && !typing) {
        event.preventDefault();
        document.querySelector<HTMLInputElement>('input[type="search"]')?.focus();
        return;
      }
      if (typing || openTopic) return;
      if (event.key === "j") selectNeighbor(1);
      else if (event.key === "k") selectNeighbor(-1);
      else if (event.key === "Enter" && selectedId) {
        const found = items.find((item) => item.topic_id === selectedId);
        if (found) setOpenTopic(found);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
    };
  }, [items, openTopic, selectNeighbor, selectedId]);

  useEffect(() => {
    setSelectedId(null);
    setOpenTopic(null);
    // Reset selection whenever the result set identity changes (filterKey).
  }, [filterKey]);

  const hasActiveFilters =
    filters.q !== "" || filters.category.length > 0 || filters.source.length > 0 || filters.momentum.length > 0 || filters.minScore !== undefined;

  return (
    <div className="page">
      {digest.data ? <DigestCard digest={digest.data} /> : null}
      {trends.data ? (
        <span className="badge" aria-label="Run summary">
          {trends.data.total} topics · updated {trends.data.cache.age_s}s ago
        </span>
      ) : null}
      <FilterBar
        filters={filters}
        onChange={updateFilters}
        onClear={clearFilters}
        sources={(sources.data ?? []).map((s) => ({ key: s.key, label: s.label }))}
      />
      {trends.isPending ? <SkeletonGrid /> : null}
      {trends.isError ? (
        <ErrorState
          error={trends.error}
          onRetry={() => {
            void trends.refetch().catch(() => {
              toast({ tone: "bad", message: "Retry failed." });
            });
          }}
        />
      ) : null}
      {trends.data && trends.data.items.length === 0 ? (
        hasActiveFilters ? (
          <EmptyState
            title="No topics match"
            hint="Try widening the filters."
            action={
              <button type="button" className="btn btn-ghost" onClick={clearFilters}>
                Clear filters
              </button>
            }
          />
        ) : (
          <EmptyState
            title="No run yet"
            hint="Run your first collection to see today's topics."
            action={
              <Link className="btn btn-primary" to="/runs">
                Go to Runs
              </Link>
            }
          />
        )
      ) : null}
      {trends.data && trends.data.items.length > 0 ? (
        <div className="topic-grid">
          {trends.data.items.map((topic) => (
            <div key={topic.topic_id} data-topic-id={topic.topic_id}>
              <TopicCard topic={topic} selected={topic.topic_id === selectedId} onOpen={setOpenTopic} />
            </div>
          ))}
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
