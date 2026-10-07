import type React from "react";
import { useEffect, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api";
import type { RawItem, SortedTopic } from "../lib/api";
import {
  useDates,
  useDigest,
  useHealth,
  useRun,
  useRuns,
  useStartRun,
  useSyncSheets,
  useTopicEvidence,
  useTrends,
} from "../hooks/useApi";
import { CategoryPicker } from "../components/CategoryPicker";
import { SortingStage } from "../components/SortingStage";
import { useActiveRun } from "../hooks/useLive";
import { useLiveSeries, useLiveStream, useSampleNow, useTopToday } from "../hooks/useLive";
import type { PulseTopicSummary } from "../lib/api";
import { LiveChart } from "../components/LiveChart";
import { useTopicFilters } from "../hooks/useFilters";
import { copyToClipboard } from "../lib/clipboard";
import { todayAppDate } from "../lib/format";
import { useToast } from "../components/Toast";
import { ErrorState, SkeletonGrid } from "../components/States";
import {
  Block,
  BlockGrid,
  EmptyNudge,
  Eyebrow,
  FlowStrip,
  Hero,
  Hl,
  Pill,
  SidePanel,
  Step,
  Steps,
} from "../components/decode";

/** Grouped flow for the recipe bar: pull → clean → jev sorts → write → rank. */
function groupedFlow(stages: { stage: string; status: string }[]): {
  key: string;
  label: string;
  status: "pending" | "running" | "done" | "failed" | "skipped";
  jev?: boolean;
}[] {
  const byStage = new Map(stages.map((s) => [s.stage, s.status]));
  const rank = (list: string[]): "pending" | "running" | "done" | "failed" | "skipped" => {
    const states = list.map((s) => byStage.get(s) ?? "pending");
    if (states.includes("failed")) return "failed";
    if (states.includes("running")) return "running";
    if (states.every((s) => s === "done" || s === "skipped")) return "done";
    if (states.every((s) => s === "pending")) return "pending";
    return "running";
  };
  return [
    { key: "pull", label: "pull", status: rank(["collect"]) },
    { key: "clean", label: "clean", status: rank(["normalize", "dedupe", "select"]) },
    { key: "jev", label: "jev sorts", status: rank(["sort_classify", "sort_cluster"]), jev: true },
    { key: "write", label: "write", status: rank(["sort_write"]) },
    { key: "rank", label: "rank", status: rank(["score", "persist_sorted", "finalize"]) },
  ];
}

const CATEGORIES = ["Tech", "AI", "Business", "Finance", "Science", "Health", "Politics", "World", "Sports", "Entertainment", "Culture", "Gaming", "Lifestyle", "Other"];

function useJevSpend(): number | null {
  const query = useQuery({
    queryKey: ["jev-health"],
    queryFn: () => api.get<{ budget_used_usd: number }>("/api/jev/health"),
    staleTime: 60_000,
    retry: false,
  });
  return typeof query.data?.budget_used_usd === "number" ? query.data.budget_used_usd : null;
}

export function Today(): React.JSX.Element {
  const [params, setParams] = useSearchParams();
  const date = params.get("date") ?? todayAppDate();
  const [filters, updateFilters, clearFilters] = useTopicFilters();
  const [openId, setOpenId] = useState<string | null>(null);

  const health = useHealth();
  const scopeParam = params.get("scope") ?? "";
  const scope = scopeParam === "" ? "all" : scopeParam;
  const trends = useTrends({
    date,
    scope,
    category: filters.category,
    source: [],
    momentum: [],
    sort: filters.sort,
    limit: 50,
    offset: 0,
    ...(filters.q ? { q: filters.q } : {}),
  });
  const digest = useDigest(date);
  const dates = useDates();
  const [mode, setMode] = useState<"strict" | "loose">("strict");
  const startRun = useStartRun();
  const setScope = (selected: string[], nextMode: "strict" | "loose"): void => {
    setMode(nextMode);
    const next = new URLSearchParams(params);
    if (selected.length === 0) next.delete("scope");
    else next.set("scope", [...selected].sort().join("+"));
    setParams(next, { replace: true });
  };
  const runScope = (): void => {
    const selected = scope === "all" ? [] : scope.split("+");
    if (selected.length === 0) return;
    startRun.mutate(
      { categories: selected, mode },
      {
        onError: (error) => {
          toast({ tone: "bad", message: error.message });
        },
      },
    );
  };
  const runs = useRuns(1, 0);
  const latestRunId = runs.data?.runs[0]?.run_id ?? null;
  const latest = useRun(latestRunId);
  const evidence = useTopicEvidence(openId);
  const spend = useJevSpend();
  const sync = useSyncSheets();
  const toast = useToast();

  if (health.data && !health.data.setup_complete) {
    return (
      <div className="page">
        <Hero eyebrow="setup" title={<>decode the day in <Hl>one picture</Hl>.</>} lede="four steps, then your first run." />
        <section aria-label="Setup checklist">
          <Steps>
            <Step index={0} title="connect google sheets">
              <p>create a sheet, share it with the service account, paste the id.</p>
              <Link className="btn btn-ghost" to="/settings">open settings</Link>
            </Step>
            <Step index={1} title="connect omniroute">
              <p>the writer behind topic cards. test it, note the model id.</p>
              <Link className="btn btn-ghost" to="/settings">open settings</Link>
            </Step>
            <Step index={2} title="connect jev">
              <p>the typed classifier. one sample classification proves the key.</p>
              <Link className="btn btn-ghost" to="/settings">open settings</Link>
            </Step>
            <Step index={3} title="run once">
              <p>pulls, sorts and ranks. watch it live on the runs page.</p>
              <Link className="btn btn-primary" to="/wizard">start the wizard</Link>
            </Step>
          </Steps>
        </section>
      </div>
    );
  }

  const goDate = (next: string): void => {
    const nextParams = new URLSearchParams(params);
    nextParams.set("date", next);
    setParams(nextParams, { replace: true });
  };

  const items = trends.data?.items ?? [];
  const openTopic: SortedTopic | null = items.find((t) => t.topic_id === openId) ?? null;
  const stale = (trends.data?.cache.age_s ?? 0) > 300;

  return (
    <div className="page">
      <section aria-label="Today's trends" style={{ marginTop: 32 }}>
        <Hero
          eyebrow="today's trends"
          title={<>the topics worth <Hl>posting about</Hl> today.</>}
          lede={digest.data?.digest ?? "one line from the writer lands here after the first run."}
        />
      </section>

      <section aria-label="Run summary">
        <BlockGrid>
          <Block variant="dark" value={digest.data?.topics_count ?? items.length} label="topics" />
          <Block value={digest.data?.items_count ?? "—"} label="items" />
          <Block
            value={digest.data ? `${String(digest.data.sources_ok)}/${String(digest.data.sources_total)}` : "—"}
            label="sources"
          />
          <Block variant="lime" value={spend !== null ? `$${spend.toFixed(2)}` : "—"} label="ai cost" />
        </BlockGrid>
        {digest.data && digest.data.sources_ok < digest.data.sources_total ? (
          <div className="banner banner-warn" role="status">
            {digest.data.sources_ok} of {digest.data.sources_total} sources worked — the rest are flagged on the runs page.
          </div>
        ) : null}
      </section>

      <CategoryPicker
        selected={scope === "all" ? [] : scope.split("+")}
        mode={mode}
        onChange={setScope}
        onRun={runScope}
        running={startRun.isPending}
      />
      <TopPulseActiveSort />
      <TopPulseSection onOpen={setOpenId} scope={scope} onRunScope={runScope} runPending={startRun.isPending} />

      {latest.data ? (
        <section aria-label="Latest run stages">
          <FlowStrip stages={groupedFlow(latest.data.stages)} />
        </section>
      ) : null}

      <section aria-label="Filters">
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <button type="button" aria-label="Previous day" className="btn btn-ghost" onClick={() => { goDate(prevDay(date)); }}>
            ‹
          </button>
          <span className="mono" aria-label="Current date">{date}</span>
          <button type="button" aria-label="Next day" className="btn btn-ghost" onClick={() => { goDate(nextDay(date)); }}>
            ›
          </button>
          {dates.data ? <span className="form-hint">{dates.data.dates.length} days with data</span> : null}
        </div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 12 }} role="group" aria-label="Category filter">
          <button
            type="button"
            className="chip"
            data-active={filters.category.length === 0 || undefined}
            onClick={() => { updateFilters({ category: [] }); }}
          >
            all
          </button>
          {CATEGORIES.map((category) => (
            <button
              key={category}
              type="button"
              className="chip"
              data-active={filters.category.includes(category) || undefined}
              onClick={() => { updateFilters({ category: [category] }); }}
            >
              {category.toLowerCase()}
            </button>
          ))}
        </div>
        <div style={{ display: "flex", gap: 8, marginTop: 12, flexWrap: "wrap" }}>
          <input
            className="input"
            type="search"
            placeholder="search topics"
            aria-label="Search topics"
            value={filters.q}
            onChange={(event) => { updateFilters({ q: event.target.value }); }}
          />
          <select
            className="select"
            aria-label="Sort topics"
            value={filters.sort}
            onChange={(event) => { updateFilters({ sort: event.target.value }); }}
          >
            <option value="score">score</option>
            <option value="rank">rank</option>
            <option value="title">title</option>
          </select>
          {filters.q || filters.category.length > 0 ? (
            <button type="button" className="btn btn-ghost" onClick={clearFilters}>
              clear filters
            </button>
          ) : null}
        </div>
        {trends.data ? (
          <div className="stale-row">
            <span>
              {trends.data.total} topics · updated {trends.data.cache.age_s}s ago
              {stale ? " · stale" : ""}
            </span>
            {stale ? (
              <button
                type="button"
                className="btn btn-ghost"
                disabled={sync.isPending}
                onClick={() => {
                  sync.mutate(undefined, {
                    onError: (error) => {
                      toast({ tone: "bad", message: error.message });
                    },
                  });
                }}
              >
                sync now
              </button>
            ) : null}
          </div>
        ) : null}
      </section>

      <section aria-label="Topics">
        {trends.isPending ? <SkeletonGrid /> : null}
        {trends.isError ? <ErrorState error={trends.error} onRetry={() => { void trends.refetch(); }} /> : null}
        {trends.data && items.length === 0 ? (
          <EmptyNudge
            title="nothing here yet"
            hint="run the pipeline and topics land in this list."
            action={<Link className="btn btn-primary" to="/runs">go to runs</Link>}
          />
        ) : null}
        {items.map((topic) => (
          <button
            key={topic.topic_id}
            type="button"
            className="topic-row"
            onClick={() => { setOpenId(topic.topic_id); }}
            aria-label={`Open ${topic.title}`}
          >
            <span className="topic-rank num">{topic.rank}</span>
            <span>
              <span className="topic-title">{topic.title}</span>
              <br />
              <span className="topic-summary">{topic.summary}</span>
              <span className="topic-meta">
                <Pill>{topic.category.toLowerCase()}</Pill>
                <Pill>{topic.momentum}</Pill>
                <span className="form-hint">{topic.source_count} {topic.source_count === 1 ? "source" : "sources"}</span>
              </span>
            </span>
            <span className="topic-score num" aria-label={`Trend score ${String(topic.trend_score)}`}>
              {topic.trend_score}
            </span>
          </button>
        ))}
      </section>

      {openTopic ? (
        <TopicPanel
          topic={openTopic}
          evidence={evidence.data?.evidence ?? []}
          onClose={() => { setOpenId(null); }}
        />
      ) : null}
    </div>
  );
}

function useNowMs(stepMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => {
      setNow(Date.now());
    }, stepMs);
    return () => {
      clearInterval(timer);
    };
  }, [stepMs]);
  return now;
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

function fmtClock(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function TopPulseSection({
  onOpen,
  scope,
  onRunScope,
  runPending,
}: {
  onOpen: (id: string) => void;
  scope: string;
  onRunScope: () => void;
  runPending: boolean;
}): React.JSX.Element | null {
  const top = useTopToday(scope);
  const [modeOverride, setModeOverride] = useState<"live" | "scores" | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const prevId = useRef<string | null>(null);
  const reducedMotion = useReducedMotion();
  const now = useNowMs();
  const toast = useToast();
  const series = useLiveSeries(top.data?.date ?? null, scope);
  const stream = useLiveStream(top.data?.date ?? null, scope);
  const sampleNow = useSampleNow();

  const payload = top.data;
  const topic = payload?.topic ?? null;

  useEffect(() => {
    if (topic && prevId.current !== null && prevId.current !== topic.topic_id) {
      setAnnouncement(`new top topic: ${topic.title}`);
      if (!reducedMotion) {
        const timer = setTimeout(() => {
          setAnnouncement((current) => (current.startsWith("new top topic") ? "" : current));
        }, 60_000);
        return () => {
          clearTimeout(timer);
        };
      }
    }
    if (topic) prevId.current = topic.topic_id;
    return undefined;
  }, [topic, reducedMotion]);

  const mode = modeOverride ?? (topic && !topic.has_live_metric ? "scores" : "live");

  if (top.isPending) {
    return (
      <section aria-label="Top topic today">
        <SkeletonGrid />
      </section>
    );
  }
  if (top.isError || !payload) {
    return (
      <section aria-label="Top topic today">
        <ErrorState error={top.error} onRetry={() => { void top.refetch(); }} />
      </section>
    );
  }
  if (!topic) {
    if (scope !== "all") {
      return (
        <section aria-label="Top topic today">
          <EmptyNudge
            title="no set for this scope yet"
            hint={`run the pipeline for ${scope} and its top topic lands here.`}
            action={
              <button type="button" className="btn btn-primary" disabled={runPending} onClick={onRunScope}>
                {runPending ? "starting…" : `run for ${scope.split("+").join(" + ")}`}
              </button>
            }
          />
        </section>
      );
    }
    return (
      <section aria-label="Top topic today">
        <EmptyNudge
          title="no top topic yet"
          hint="run the pipeline and today's top topic lands here."
          action={<Link className="btn btn-primary" to="/runs">run now</Link>}
        />
      </section>
    );
  }

  const live = payload.live;
  const countdown = live.next_sample_at ? Math.max(0, Math.round((Date.parse(live.next_sample_at) - now) / 1000)) : null;
  const badge =
    stream.status === "polling"
      ? "reconnecting · polling every 30s"
      : stream.status === "paused"
        ? "paused"
        : stream.status === "reconnecting"
          ? "reconnecting"
          : live.status === "stale"
            ? `stale · last sample ${fmtClock(live.last_sample_at)}`
            : live.status === "paused"
              ? "paused · sampler disabled"
              : `live · sampled ${fmtClock(live.last_sample_at)}${countdown !== null ? ` · next in ${String(Math.floor(countdown / 60)).padStart(2, "0")}:${String(countdown % 60).padStart(2, "0")}` : ""}`;

  const chartSeries = (series.data?.series ?? []).map((s) => ({ ...s, points: s.points.slice(-300) }));
  const scoreBars = [topic, ...payload.runner_ups].map((t: PulseTopicSummary) => ({ topic_id: t.topic_id, title: t.title, score: t.score }));

  return (
    <section aria-label="Top topic today" className={announcement.startsWith("new top topic") && !reducedMotion ? "pulse-flash" : undefined}>
      <div className="pulse-grid">
        <div className="pulse-card">
          <Eyebrow>top topic today{payload.from_previous_day ? ` · from ${payload.date}` : ""}</Eyebrow>
          <h2>
            <Hl>{topic.title}</Hl>
          </h2>
          <p>{topic.summary}</p>
          <p className="form-hint">{topic.why_trending}</p>
          <div className="topic-meta">
            <Pill>{topic.category.toLowerCase()}</Pill>
            <Pill>{topic.momentum}</Pill>
            <span className="form-hint num">score {topic.score}</span>
          </div>
          <p className="form-hint">
            {topic.source_count} {topic.source_count === 1 ? "source" : "sources"} · {topic.items_count} {topic.items_count === 1 ? "item" : "items"}
          </p>
          {topic.first_angle ? (
            <div className="angle">
              <span>{topic.first_angle}</span>
              <button type="button" className="btn btn-ghost" aria-label="Copy first angle" onClick={() => { copyToClipboard(topic.first_angle); }}>
                copy
              </button>
            </div>
          ) : null}
          <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
            <button type="button" className="btn btn-ghost" onClick={() => { onOpen(topic.topic_id); }}>
              open details
            </button>
          </div>
        </div>
        <div className="pulse-graph">
          <div className="pulse-graph-head">
            <Eyebrow>growth since {fmtClock(series.data?.baseline_at ?? live.last_sample_at)}</Eyebrow>
            <span className="mono" role="status" aria-label="live status">{badge}</span>
          </div>
          {!payload.from_previous_day && topic.has_live_metric ? (
            <>
              <LiveChart series={chartSeries} mode={mode} scores={scoreBars} onSelectTopic={onOpen} />
              <div style={{ display: "flex", gap: 8, marginTop: 8, alignItems: "center" }}>
                <div role="group" aria-label="Chart view">
                  <button type="button" className="chip" data-active={mode === "live" || undefined} onClick={() => { setModeOverride("live"); }}>
                    live
                  </button>
                  <button type="button" className="chip" data-active={mode === "scores" || undefined} onClick={() => { setModeOverride("scores"); }}>
                    scores
                  </button>
                </div>
                <button
                  type="button"
                  className="btn btn-ghost"
                  disabled={sampleNow.isPending}
                  onClick={() => {
                    sampleNow.mutate(undefined, {
                      onError: (error) => {
                        toast({ tone: "bad", message: error.message });
                      },
                    });
                  }}
                >
                  sample now
                </button>
              </div>
            </>
          ) : (
            <>
              <LiveChart series={[]} mode="scores" scores={scoreBars} onSelectTopic={onOpen} />
              <p className="form-hint" style={{ marginTop: 8 }}>
                {payload.from_previous_day ? `showing ${payload.date} — no live line for past days.` : "no live numbers for this topic's sources."}
              </p>
            </>
          )}
        </div>
      </div>
      <div className="visually-hidden" aria-live="polite">{announcement}</div>
    </section>
  );
}

function TopPulseActiveSort(): React.JSX.Element | null {
  const active = useActiveRun();
  if (!active.data?.run_id) return null;
  return <SortingStage runId={active.data.run_id} />;
}

function prevDay(date: string): string {
  return shiftDay(date, -1);
}

function nextDay(date: string): string {
  return shiftDay(date, 1);
}

function shiftDay(date: string, delta: number): string {
  const [y, m, d] = date.split("-").map(Number);
  const dt = new Date(Date.UTC(y ?? 2026, (m ?? 1) - 1, d ?? 1));
  dt.setUTCDate(dt.getUTCDate() + delta);
  return dt.toISOString().slice(0, 10);
}

function TopicPanel({
  topic,
  evidence,
  onClose,
}: {
  topic: SortedTopic;
  evidence: RawItem[];
  onClose: () => void;
}): React.JSX.Element {
  return (
    <SidePanel title={topic.title} onClose={onClose}>
      <Eyebrow>rank {topic.rank} · score {topic.trend_score}</Eyebrow>
      <h2>{topic.title}</h2>
      <p>{topic.summary}</p>
      <div className="topic-meta">
        <Pill>{topic.category.toLowerCase()}</Pill>
        <Pill>{topic.momentum}</Pill>
        <Pill>{topic.sentiment}</Pill>
      </div>
      <h3>score breakdown</h3>
      <div className="score-parts">
        <div><div className="v num">{topic.score_engagement.toFixed(2)}</div><div className="k">engagement</div></div>
        <div><div className="v num">{topic.score_diversity.toFixed(2)}</div><div className="k">diversity</div></div>
        <div><div className="v num">{topic.score_relevance.toFixed(2)}</div><div className="k">relevance</div></div>
        <div><div className="v num">{topic.score_novelty.toFixed(2)}</div><div className="k">novelty</div></div>
      </div>
      <h3>why trending</h3>
      <p>{topic.why_trending}</p>
      <h3>content angles</h3>
      {topic.content_angles.map((angle, index) => (
        <div className="angle" key={index}>
          <span>{angle}</span>
          <button type="button" className="btn btn-ghost" aria-label={`Copy angle ${String(index + 1)}`} onClick={() => { copyToClipboard(angle); }}>
            copy
          </button>
        </div>
      ))}
      <h3>evidence</h3>
      {evidence.length === 0 ? <p className="form-hint">no linked items.</p> : null}
      <ul className="evidence-list">
        {evidence.map((item) => (
          <li key={item.id}>
            <a href={item.url} target="_blank" rel="noopener noreferrer">{item.title}</a>
          </li>
        ))}
      </ul>
    </SidePanel>
  );
}
