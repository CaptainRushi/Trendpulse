/**
 * SortingStage (Doc 17 S5): live sorting animation from real pipeline events.
 * Dots drop into category bins as sort_batch events arrive, merge into blobs
 * on sort_clusters, become titled cards on sort_topics, and reorder by score
 * (FLIP) on sort_rank. Every dot is a real item; nothing is faked. Reduced
 * motion shows counters only. Transform/opacity animations only.
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { api } from "../lib/api";

export const DOT_CAP = 150;

interface DotState {
  id: string;
  title: string;
  category: string;
  tray: "bins" | "discarded" | "off";
  clusterId?: string;
  cardTitle?: string;
  rank?: number;
  score?: number;
}

interface ClusterState {
  id: string;
  category: string;
  memberIds: string[];
}

type Phase = "classify" | "filter" | "cluster" | "write" | "rank" | "done";

const PHASE_LABEL: Record<Phase, string> = {
  classify: "classify",
  filter: "filter",
  cluster: "cluster",
  write: "write",
  rank: "rank",
  done: "done",
};

interface SortEvent {
  type?: string;
  phase?: Phase;
  stage?: string;
  items?: { id: string; t: string; c: string; q: number; f: boolean; d: boolean; o: boolean }[];
  done?: number;
  total?: number;
  jev_calls?: number;
  fallback_calls?: number;
  cost_usd?: number;
  clusters?: { id: string; category: string; size: number; member_ids: string[] }[];
  topics?: { cluster_id: string; title: string }[];
  ranks?: { cluster_id: string; rank: number; score: number }[];
}

interface Snapshot {
  phase: Phase | null;
  events: SortEvent[];
}

function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(
    () => typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches,
  );
  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return undefined;
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const onChange = (): void => {
      setReduced(query.matches);
    };
    query.addEventListener("change", onChange);
    return () => {
      query.removeEventListener("change", onChange);
    };
  }, []);
  return reduced;
}

function applyEvent(
  dots: Map<string, DotState>,
  clusters: Map<string, ClusterState>,
  event: SortEvent,
): { classified: number; total: number; jev: number; fallback: number; cost: number } | null {
  if (event.type === "sort_batch" && event.items) {
    let classified = 0;
    for (const item of event.items) {
      classified += 1;
      const dot = dots.get(item.id) ?? { id: item.id, title: item.t, category: item.c, tray: "bins" as const };
      dot.title = item.t || dot.title;
      dot.category = item.c || dot.category;
      if (item.d) dot.tray = "discarded";
      else if (item.o) dot.tray = "off";
      else dot.tray = "bins";
      dots.set(item.id, dot);
    }
    return { classified, total: event.total ?? classified, jev: event.jev_calls ?? 0, fallback: event.fallback_calls ?? 0, cost: event.cost_usd ?? 0 };
  }
  if (event.type === "sort_clusters" && event.clusters) {
    for (const cluster of event.clusters) {
      clusters.set(cluster.id, { id: cluster.id, category: cluster.category, memberIds: cluster.member_ids });
      for (const id of cluster.member_ids) {
        const dot = dots.get(id);
        if (dot) dot.clusterId = cluster.id;
      }
    }
  }
  if (event.type === "sort_topics" && event.topics) {
    for (const topic of event.topics) {
      const cluster = clusters.get(topic.cluster_id);
      if (cluster) {
        for (const id of cluster.memberIds) {
          const dot = dots.get(id);
          if (dot) dot.cardTitle = topic.title;
        }
      }
    }
  }
  if (event.type === "sort_rank" && event.ranks) {
    for (const rank of event.ranks) {
      const cluster = clusters.get(rank.cluster_id);
      if (cluster) {
        for (const id of cluster.memberIds) {
          const dot = dots.get(id);
          if (dot) {
            dot.rank = rank.rank;
            dot.score = rank.score;
          }
        }
      }
    }
  }
  return null;
}

interface SortModel {
  dots: Map<string, DotState>;
  clusters: Map<string, ClusterState>;
}

function applyBatch(model: SortModel, batch: SortEvent[], onPhase: (phase: Phase) => void): { model: SortModel; counts: { classified: number; total: number; jev: number; fallback: number; cost: number } } {
  const dots = new Map(model.dots);
  const clusters = new Map(model.clusters);
  const counts = { classified: 0, total: 0, jev: 0, fallback: 0, cost: 0 };
  for (const event of batch) {
    if (event.type === "sort_phase" && event.phase) onPhase(event.phase);
    const result = applyEvent(dots, clusters, event);
    if (result) {
      counts.classified += result.classified;
      counts.total = Math.max(counts.total, result.total);
      counts.jev = result.jev;
      counts.fallback = result.fallback;
      counts.cost = result.cost;
    }
  }
  return { model: { dots, clusters }, counts };
}

export function SortingStage({ runId, compact = false }: { runId: string; compact?: boolean }): React.JSX.Element | null {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [model, setModel] = useState<SortModel>({ dots: new Map(), clusters: new Map() });
  const [phase, setPhase] = useState<Phase | null>(null);
  const [counters, setCounters] = useState({ classified: 0, total: 0, jev: 0, fallback: 0, cost: 0 });
  const [collapsed, setCollapsed] = useState(false);
  const [replaying, setReplaying] = useState(false);
  const [inspected, setInspected] = useState<string | null>(null);
  const [visible, setVisible] = useState(true);
  const [announcement, setAnnouncement] = useState("");
  const reducedMotion = useReducedMotion();
  const buffer = useRef<SortEvent[]>([]);
  const cardRefs = useRef(new Map<string, HTMLDivElement>());
  const modelRef = useRef<SortModel>({ dots: new Map<string, DotState>(), clusters: new Map<string, ClusterState>() });

  // Initial snapshot (mid-sort opens start here), then live deltas.
  useEffect(() => {
    let disposed = false;
    api
      .get<Snapshot>(`/api/runs/${runId}/sort-state`)
      .then((snap) => {
        if (disposed) return;
        setSnapshot(snap);
        const next: SortModel = { dots: new Map(), clusters: new Map() };
        const totals = { classified: 0, total: 0, jev: 0, fallback: 0, cost: 0 };
        for (const event of snap.events) {
          if (event.type === "sort_batch") {
            const items = Array.isArray(event.items) ? event.items : [];
            totals.classified += items.length;
            totals.total = Math.max(totals.total, typeof event.total === "number" ? event.total : items.length);
            if (typeof event.jev_calls === "number") totals.jev = event.jev_calls;
            if (typeof event.fallback_calls === "number") totals.fallback = event.fallback_calls;
            if (typeof event.cost_usd === "number") totals.cost = event.cost_usd;
          }
          applyEvent(next.dots, next.clusters, event);
        }
        modelRef.current = next;
        setModel(next);
        setCounters(totals);
        setPhase(snap.phase);
      })
      .catch(() => undefined);
    return () => {
      disposed = true;
    };
  }, [runId]);

  // Live deltas over SSE.
  useEffect(() => {
    if (typeof EventSource === "undefined") return undefined;
    const source = new EventSource(`/api/runs/${runId}/stream`);
    const onSort = (event: Event): void => {
      try {
        const raw: unknown = (event as MessageEvent).data;
        if (typeof raw !== "string") return;
        const data = JSON.parse(raw) as SortEvent;
        buffer.current.push(data);
      } catch {
        // ignore malformed frames
      }
    };
    for (const type of ["sort_batch", "sort_clusters", "sort_topics", "sort_rank", "sort_phase"]) {
      source.addEventListener(type, onSort);
    }
    return () => {
      source.close();
    };
  }, [runId]);

  // Playback pump: apply buffered events in 400 ms ticks (never >4 s behind).
  useEffect(() => {
    const timer = setInterval(() => {
      const batch = buffer.current.splice(0, buffer.current.length);
      if (batch.length === 0) return;
      const { model: next, counts } = applyBatch(modelRef.current, batch, setPhase);
      modelRef.current = next;
      setModel(next);
      setCounters((c) => ({
        classified: c.classified + counts.classified,
        total: Math.max(c.total, counts.total),
        jev: counts.jev,
        fallback: counts.fallback,
        cost: counts.cost,
      }));
    }, 400);
    return () => {
      clearInterval(timer);
    };
  }, []);

  // Polite announcements: phase changes only, never per item.
  useEffect(() => {
    if (phase) setAnnouncement(`sorting phase: ${PHASE_LABEL[phase]}`);
  }, [phase]);

  // Fade a few seconds after done.
  useEffect(() => {
    if (phase !== "done" || replaying) return undefined;
    const timer = setTimeout(() => {
      setVisible(false);
    }, 5000);
    return () => {
      clearTimeout(timer);
    };
  }, [phase, replaying]);

  // FLIP reorder for ranked cards (transform only).
  const dots = model.dots;
  const ranked = useMemo(() => {
    const cards = new Map<string, { title: string; rank: number; score: number }>();
    for (const dot of dots.values()) {
      if (dot.cardTitle !== undefined && dot.rank !== undefined && dot.score !== undefined) {
        const key = dot.clusterId ?? dot.id;
        if (!cards.has(key)) cards.set(key, { title: dot.cardTitle, rank: dot.rank, score: dot.score });
      }
    }
    return [...cards.entries()].sort((a, b) => a[1].rank - b[1].rank);
  }, [dots]);

  useLayoutEffect(() => {
    if (reducedMotion) return;
    const first = new Map<string, number>();
    for (const [key, el] of cardRefs.current) {
      const rect = el.getBoundingClientRect();
      first.set(key, rect.top);
    }
    requestAnimationFrame(() => {
      for (const [key, el] of cardRefs.current) {
        const prev = first.get(key);
        if (prev === undefined) continue;
        const dy = prev - el.getBoundingClientRect().top;
        if (dy !== 0) {
          el.style.transform = `translateY(${String(dy)}px)`;
          el.style.transition = "none";
          requestAnimationFrame(() => {
            el.style.transition = "transform 450ms ease";
            el.style.transform = "";
          });
        }
      }
    });
  }, [ranked, reducedMotion]);

  if (!visible && !replaying) return null;
  if (snapshot === null && dots.size === 0 && phase === null) return null;

  const skip = (): void => {
    const rest = buffer.current.splice(0, buffer.current.length);
    if (rest.length === 0) return;
    const { model: next } = applyBatch(modelRef.current, rest, setPhase);
    modelRef.current = next;
    setModel(next);
  };

  const replay = (): void => {
    setReplaying(true);
    setVisible(true);
    const empty: SortModel = { dots: new Map(), clusters: new Map() };
    modelRef.current = empty;
    setModel(empty);
    setPhase(null);
    const events: SortEvent[] = snapshot?.events ?? [];
    let i = 0;
    const timer = setInterval(() => {
      const chunk = events.slice(i, i + 20);
      i += 20;
      if (chunk.length === 0) {
        clearInterval(timer);
        setReplaying(false);
        return;
      }
      const { model: next } = applyBatch(modelRef.current, chunk, setPhase);
      modelRef.current = next;
      setModel(next);
    }, 300);
  };

  if (reducedMotion) {
    return (
      <section aria-label="Sorting progress">
        <div className="mono" role="status">
          {phase ? `phase: ${PHASE_LABEL[phase]}` : "preparing"} · classify {counters.classified}/{counters.total} · jev {counters.jev} · fallback {counters.fallback} · ${counters.cost.toFixed(4)}
        </div>
        <div className="score-bar-track" role="progressbar" aria-valuenow={counters.total > 0 ? Math.round((counters.classified / counters.total) * 100) : 0} aria-valuemin={0} aria-valuemax={100}>
          <span className="score-bar-fill" style={{ width: `${counters.total > 0 ? String(Math.round((counters.classified / counters.total) * 100)) : "0"}%` }} />
        </div>
        {ranked.length > 0 ? (
          <ol>
            {ranked.map(([key, card]) => (
              <li key={key}>{card.title} · score {card.score}</li>
            ))}
          </ol>
        ) : null}
      </section>
    );
  }

  const dotList = [...dots.values()];
  const shown = dotList.slice(0, DOT_CAP);
  const hidden = dotList.length - shown.length;
  const bins = new Map<string, DotState[]>();
  for (const dot of shown) {
    const key = dot.tray === "bins" ? dot.category : dot.tray;
    const list = bins.get(key) ?? [];
    list.push(dot);
    bins.set(key, list);
  }

  return (
    <section aria-label="Sorting progress">
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <span className="eyebrow">sorting</span>
        <span className="mono" role="status">
          {phase ? PHASE_LABEL[phase] : "…"} · classify {counters.classified}/{counters.total} · jev {counters.jev} · fallback {counters.fallback} · ${counters.cost.toFixed(4)}
        </span>
        <button type="button" className="btn btn-ghost" onClick={skip}>
          skip
        </button>
        <button type="button" className="btn btn-ghost" onClick={replay} disabled={replaying}>
          replay
        </button>
        <button type="button" className="btn btn-ghost" aria-expanded={!collapsed} onClick={() => { setCollapsed((v) => !v); }}>
          {collapsed ? "expand" : "collapse"}
        </button>
      </div>
      {!collapsed ? (
        <>
          <div className="sort-bins">
            {[...bins.entries()].map(([bin, items]) => (
              <div
                key={bin}
                className="sort-bin"
                tabIndex={0}
                role="button"
                aria-label={`${bin}: ${String(items.length)} items. Press Enter for titles.`}
                onClick={() => { setInspected(bin); }}
                onKeyDown={(e) => { if (e.key === "Enter") setInspected(bin); }}
              >
                <span className="mono">{bin} · {items.length}</span>
                {!compact ? (
                  <span className="sort-dots" aria-hidden="true">
                    {items.slice(0, 40).map((d) => (
                      <span key={d.id} className="sort-dot" data-cat={d.category} title={d.title} />
                    ))}
                  </span>
                ) : null}
              </div>
            ))}
            {hidden > 0 ? <span className="form-hint">+{hidden} more</span> : null}
          </div>
          {inspected ? (
            <ul aria-label={`Latest titles in ${inspected}`}>
              {(bins.get(inspected) ?? []).slice(-5).map((d) => (
                <li key={d.id}>{d.title}</li>
              ))}
            </ul>
          ) : null}
          {ranked.length > 0 ? (
            <ol className="sort-cards" aria-label="Ranked topics">
              {ranked.map(([key, card], i) => (
                <li key={key}>
                  <div
                    className="sort-card"
                    data-top={i === 0 || undefined}
                    ref={(el) => {
                      if (el) cardRefs.current.set(key, el);
                      else cardRefs.current.delete(key);
                    }}
                  >
                    <span className="num">{card.rank}</span> {card.title} · score {card.score}
                  </div>
                </li>
              ))}
            </ol>
          ) : null}
        </>
      ) : null}
      <div className="visually-hidden" aria-live="polite">{announcement}</div>
    </section>
  );
}
