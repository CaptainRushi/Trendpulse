/**
 * Today (Doc 19 Q5): my-categories chip row, hero top topic, one panel per
 * selected category (max 5 topics each), onboarding when empty.
 */
import type React from "react";
import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";
import type { SortedTopic } from "../lib/api";
import {
  useDigest,
  useHealth,
  useMyCategories,
  useRun,
  useRuns,
  useSaveMyCategories,
  useStartRun,
  useTodayCategories,
  useTopicEvidence,
} from "../hooks/useApi";
import { useActiveRun, useEstimate } from "../hooks/useLive";
import { useRunEvents } from "../hooks/useEventSource";
import { CategoryPanels, OnboardingCard } from "../components/CategoryPanels";
import { MyCategories } from "../components/MyCategories";
import { SortingStage } from "../components/SortingStage";
import { todayAppDate } from "../lib/format";
import { useToast } from "../components/Toast";
import { ErrorState, SkeletonGrid } from "../components/States";
import {
  Block,
  BlockGrid,
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
    { key: "jev", label: "jev sorts", status: rank(["sort_classify", "sort_assign", "sort_cluster"]), jev: true },
    { key: "write", label: "write", status: rank(["sort_write"]) },
    { key: "rank", label: "rank", status: rank(["score", "persist_sorted", "finalize"]) },
  ];
}

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
  const [openId, setOpenId] = useState<string | null>(null);
  const [showEstimate, setShowEstimate] = useState(false);
  const [announcement, setAnnouncement] = useState("");
  const prevStatuses = useRef(new Map<string, string>());
  const toast = useToast();
  const queryClient = useQueryClient();
  const date = todayAppDate();

  const health = useHealth();
  const myCats = useMyCategories();
  const my = myCats.data?.my_categories ?? [];
  const max = myCats.data?.max_categories ?? 6;
  const active = useActiveRun();
  const activeRunId = active.data?.run_id ?? null;
  const panels = useTodayCategories(activeRunId !== null);
  const digest = useDigest(date);
  const spend = useJevSpend();
  const startRun = useStartRun();
  const saveMy = useSaveMyCategories();
  const estimate = useEstimate(my, "strict");
  const events = useRunEvents(activeRunId);
  const evidence = useTopicEvidence(openId);
  const runs = useRuns(1, 0);
  const latestRunId = runs.data?.runs[0]?.run_id ?? null;
  const latest = useRun(latestRunId);

  const eventCount = events.events.length;
  useEffect(() => {
    if (eventCount === 0) return;
    const last = events.events[events.events.length - 1];
    if (last && (last.type === "category_status" || last.type === "sort_rank" || last.type === "done")) {
      void queryClient.invalidateQueries({ queryKey: ["today-categories"] });
    }
  }, [eventCount, events.events, queryClient]);

  useEffect(() => {
    const list = panels.data?.categories ?? [];
    const msgs: string[] = [];
    for (const panel of list) {
      const prev = prevStatuses.current.get(panel.category);
      if (prev === "running" && panel.status !== "running") {
        msgs.push(`${panel.category} finished (${panel.status.replace("_", " ")})`);
      }
      prevStatuses.current.set(panel.category, panel.status);
    }
    if (msgs.length > 0) setAnnouncement(msgs.join(". "));
  }, [panels.data]);

  if (health.data && !health.data.setup_complete) {
    return (
      <div className="page">
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
            <Step index={4} title="pick your categories">
              <p>today shows the top 5 topics for each category you pick.</p>
              <MyCategories
                my={my}
                max={max}
                saving={saveMy.isPending}
                onSave={(next) => {
                  saveMy.mutate(next, {
                    onError: (error) => {
                      toast({ tone: "bad", message: error.message });
                    },
                  });
                }}
              />
            </Step>
          </Steps>
        </section>
      </div>
    );
  }

  const runCategories = (categories: string[]): void => {
    startRun.mutate(
      { categories },
      {
        onSuccess: () => {
          void queryClient.invalidateQueries({ queryKey: ["active-run"] });
          void queryClient.invalidateQueries({ queryKey: ["today-categories"] });
        },
        onError: (error) => {
          toast({ tone: "bad", message: error.message });
        },
      },
    );
  };
  const busy = startRun.isPending || activeRunId !== null;

  const allTopics = (panels.data?.categories ?? []).flatMap((panel) => panel.topics);
  const topTopic = allTopics.reduce<(typeof allTopics)[number] | null>(
    (best, topic) => (best === null || topic.score > best.score ? topic : best),
    null,
  );
  const openTopic = evidence.data?.topic as SortedTopic | undefined;

  return (
    <div className="page">
      <section aria-label="Today's trends" style={{ marginTop: 32 }}>
        <Hero
          eyebrow="today's trends"
          title={topTopic ? <>{topTopic.title}</> : <>the topics worth <Hl>posting about</Hl> today.</>}
          lede={digest.data?.digest ?? "one line from the writer lands here after the first run."}
        />
      </section>

      <section aria-label="Run summary">
        <BlockGrid>
          <Block variant="dark" value={my.length} label="categories" />
          <Block value={digest.data?.topics_count ?? allTopics.length} label="topics" />
          <Block value={digest.data?.items_count ?? "—"} label="items" />
          <Block variant="lime" value={spend !== null ? `$${spend.toFixed(2)}` : "—"} label="ai cost" />
        </BlockGrid>
      </section>

      <section aria-label="My categories">
        {myCats.isPending ? <SkeletonGrid /> : null}
        {myCats.isError ? <ErrorState error={myCats.error} onRetry={() => { void myCats.refetch(); }} /> : null}
        {myCats.data && my.length === 0 ? (
          <OnboardingCard
            max={max}
            saving={saveMy.isPending}
            onSave={(next) => {
              saveMy.mutate(next, {
                onError: (error) => {
                  toast({ tone: "bad", message: error.message });
                },
              });
            }}
          />
        ) : null}
        {my.length > 0 ? (
          <>
            <MyCategories
              my={my}
              max={max}
              saving={saveMy.isPending}
              onSave={(next) => {
                saveMy.mutate(next, {
                  onError: (error) => {
                    toast({ tone: "bad", message: error.message });
                  },
                });
              }}
              onRunCategory={(slug) => { runCategories([slug]); }}
            />
            <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", marginTop: 8 }}>
              <button type="button" className="btn btn-primary" disabled={busy} onClick={() => { runCategories(my); }}>
                {busy ? "running…" : "run now"}
              </button>
              <button type="button" className="btn btn-ghost" aria-expanded={showEstimate} onClick={() => { setShowEstimate((v) => !v); }}>
                estimate{estimate.data ? ` ≈ $${estimate.data.cost_usd_estimate.toFixed(4)}` : ""}
              </button>
            </div>
            {showEstimate ? (
              <div className="estimate-pop" role="dialog" aria-label="run estimate">
                {estimate.isPending ? <p className="form-hint">estimating…</p> : null}
                {estimate.data ? (
                  <>
                    <ul>
                      {estimate.data.per_category.map((row) => (
                        <li key={row.category} className="mono">
                          {row.category}: ~{row.expected_new_items} new items · {row.jev_calls_expected} jev calls
                        </li>
                      ))}
                    </ul>
                    <p className="mono">
                      total ≈ ${estimate.data.cost_usd_estimate.toFixed(4)} · {estimate.data.jev_calls_expected} jev calls · {estimate.data.writer_calls_expected} writer calls
                    </p>
                    {estimate.data.warnings.length > 0 ? (
                      <p className="form-hint">{estimate.data.warnings.join(" · ")}</p>
                    ) : null}
                  </>
                ) : null}
              </div>
            ) : null}
          </>
        ) : null}
      </section>

      {activeRunId ? (
        <section aria-label="Live sort">
          <SortingStage runId={activeRunId} categories={my} />
        </section>
      ) : null}

      {my.length > 0 ? (
        <section aria-label="Category trends">
          {panels.isPending ? <SkeletonGrid /> : null}
          {panels.isError ? <ErrorState error={panels.error} onRetry={() => { void panels.refetch(); }} /> : null}
          {panels.data ? (
            <CategoryPanels
              panels={panels.data.categories}
              running={busy}
              onRefresh={(slug) => { runCategories([slug]); }}
              onOpen={(id) => { setOpenId(id); }}
            />
          ) : null}
        </section>
      ) : null}

      {latest.data ? (
        <section aria-label="Latest run stages">
          <FlowStrip stages={groupedFlow(latest.data.stages)} />
        </section>
      ) : null}

      <div className="visually-hidden" aria-live="polite">{announcement}</div>

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

function TopicPanel({
  topic,
  evidence,
  onClose,
}: {
  topic: SortedTopic;
  evidence: { id: string; title: string; url: string }[];
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
