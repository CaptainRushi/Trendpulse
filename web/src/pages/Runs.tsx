import type React from "react";
import { useEffect } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useRetryRun, useRun, useRuns, useStartRun } from "../hooks/useApi.js";
import { useRunEvents } from "../hooks/useEventSource.js";
import { formatDateTime, formatDurationMs } from "../lib/format.js";
import { useToast } from "../components/Toast.js";
import { EmptyState, ErrorState, SkeletonGrid } from "../components/States.js";
import { StatusPill } from "../components/badges.js";

const STAGE_LABELS: Record<string, string> = {
  collect: "Collect",
  normalize: "Normalize",
  dedupe: "Dedupe",
  engagement_norm: "Engagement",
  persist_raw: "Persist raw",
  sort_map: "Sort map",
  sort_reduce: "Sort reduce",
  score: "Score",
  persist_sorted: "Persist sorted",
  finalize: "Finalize",
};
const STAGE_ORDER = Object.keys(STAGE_LABELS);

/**
 * Runs (§5.6): history list + detail (stage stepper, per-source table,
 * live log over SSE with aria-live, retry / re-sort actions).
 */
export function Runs(): React.JSX.Element {
  const { runId } = useParams();
  const navigate = useNavigate();
  const toast = useToast();
  const runs = useRuns(20, 0);
  const selectedId = runId ?? runs.data?.runs[0]?.run_id ?? null;
  const detail = useRun(selectedId);
  const live = useRunEvents(selectedId);
  const retry = useRetryRun();
  const startResort = useStartRun();

  useEffect(() => {
    if (!runId && runs.data && runs.data.runs.length > 0) {
      const first = runs.data.runs[0]?.run_id;
      if (first) {
        void navigate(`/runs/${first}`, { replace: true });
      }
    }
  }, [runId, runs.data, navigate]);

  return (
    <div className="page">
      <h1 style={{ margin: 0 }}>Runs</h1>
      {runs.isPending ? <SkeletonGrid count={2} /> : null}
      {runs.isError ? <ErrorState error={runs.error} /> : null}
      {runs.data && runs.data.runs.length === 0 ? (
        <EmptyState title="No runs yet" hint="Start your first pipeline run." />
      ) : null}
      {runs.data && runs.data.runs.length > 0 ? (
        <div className="runs-layout">
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }} role="list" aria-label="Run history">
            {runs.data.runs.map((run) => (
              <button
                key={run.run_id}
                type="button"
                className="run-item"
                role="listitem"
                data-active={run.run_id === selectedId || undefined}
                onClick={() => {
                  void navigate(`/runs/${run.run_id}`);
                }}
              >
                <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                  <span className="mono">{run.run_date}</span>
                  <StatusPill status={run.status} />
                </div>
                <div className="badge">
                  {run.trigger} · {run.items_collected} items · {run.topics_count} topics
                </div>
              </button>
            ))}
          </div>

          <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
            {detail.isPending ? <SkeletonGrid count={1} /> : null}
            {detail.isError ? <ErrorState error={detail.error} /> : null}
            {detail.data ? <RunDetailView runId={selectedId ?? ""} /> : null}
            {selectedId ? (
              <section className="card" aria-label="Live log">
                <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                  <strong>Live log</strong>
                  <span className="badge" aria-label={live.connected ? "Stream connected" : "Stream disconnected"}>
                    {live.connected ? "● connected" : "○ disconnected"}
                  </span>
                </div>
                <div className="log-viewer" role="log" aria-live="polite" aria-label="Run events">
                  {live.events.length === 0 ? "No events yet." : null}
                  {live.events.map((event, index) => (
                    <div key={index}>
                      [{event.type}] {JSON.stringify(event.data ?? event)}
                    </div>
                  ))}
                </div>
              </section>
            ) : null}
            {detail.data && (detail.data.run.status === "failed" || detail.data.run.status === "interrupted") ? (
              <div style={{ display: "flex", gap: 8 }}>
                <button
                  type="button"
                  className="btn btn-primary"
                  disabled={retry.isPending}
                  onClick={() => {
                    if (!selectedId) return;
                    retry.mutate(
                      { runId: selectedId },
                      {
                        onSuccess: () => {
                          toast({ tone: "good", message: "Retry started." });
                        },
                        onError: (error) => {
                          toast({ tone: "bad", message: error.message });
                        },
                      },
                    );
                  }}
                >
                  Retry failed stage
                </button>
                <button
                  type="button"
                  className="btn btn-ghost"
                  disabled={startResort.isPending}
                  onClick={() => {
                    startResort.mutate(
                      { stages: ["sort_map", "sort_reduce", "score", "persist_sorted", "finalize"], date: detail.data.run.run_date },
                      {
                        onSuccess: () => {
                          toast({ tone: "good", message: "Re-sort started." });
                        },
                        onError: (error) => {
                          toast({ tone: "bad", message: error.message });
                        },
                      },
                    );
                  }}
                >
                  Re-sort only
                </button>
              </div>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function RunDetailView({ runId }: { runId: string }): React.JSX.Element {
  const detail = useRun(runId);
  if (!detail.data) return <EmptyState title="No detail" />;
  const { run, stages, source_stats: stats, llm } = detail.data;
  const byStage = new Map(stages.map((s) => [s.stage, s.status]));
  return (
    <>
      <section className="card" aria-label="Run summary">
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <span className="mono">{run.run_id.slice(0, 8)}</span>
          <StatusPill status={run.status} />
          <span className="badge">
            {run.items_collected} collected · {run.items_new} new · {run.topics_count} topics ·{" "}
            {llm.calls} LLM calls
          </span>
        </div>
        {run.error ? <p role="alert">{run.error}</p> : null}
      </section>
      <section className="card" aria-label="Stages">
        <ol className="stepper">
          {STAGE_ORDER.map((stage) => (
            <li key={stage} data-status={byStage.get(stage) ?? "pending"}>
              {STAGE_LABELS[stage] ?? stage}
            </li>
          ))}
        </ol>
      </section>
      <section className="card" aria-label="Per-source results" style={{ overflowX: "auto" }}>
        <table className="data-table">
          <thead>
            <tr>
              <th scope="col">Source</th>
              <th scope="col">Status</th>
              <th scope="col">Items</th>
              <th scope="col">Duration</th>
              <th scope="col">Error</th>
            </tr>
          </thead>
          <tbody>
            {stats.map((stat) => (
              <tr key={stat.source}>
                <td>{stat.source}</td>
                <td><StatusPill status={stat.status} /></td>
                <td>{stat.items}</td>
                <td>{formatDurationMs(stat.duration_ms)}</td>
                <td>{stat.error ?? "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
      <span className="badge">Started {formatDateTime(run.started_at)}</span>
    </>
  );
}
