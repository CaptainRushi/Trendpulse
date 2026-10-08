/**
 * Live growth section (Doc 19 graph restoration): one LiveChart series per
 * selected category's #1 topic, scores fallback, sample-now. Categories
 * whose #1 has no samples yet get a plain note instead of a line.
 */
import { useMemo, useState } from "react";
import type React from "react";
import { useQueries, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";
import type { CategoryPanelData, PulseSamples } from "../lib/api";
import { useSampleNow } from "../hooks/useLive";
import { LiveChart } from "./LiveChart";
import { Eyebrow } from "./decode";
import { useToast } from "./Toast";

export function LiveSection({
  date,
  panels,
  onOpen,
}: {
  date: string;
  panels: CategoryPanelData[];
  onOpen: (id: string) => void;
}): React.JSX.Element | null {
  const [modeOverride, setModeOverride] = useState<"live" | "scores" | null>(null);
  const toast = useToast();
  const queryClient = useQueryClient();
  const tops = useMemo(
    () =>
      panels.flatMap((panel) => {
        const first = panel.topics[0];
        return first ? [{ category: panel.category, id: first.id, title: first.title, score: first.score }] : [];
      }),
    [panels],
  );
  const results = useQueries({
    queries: tops.map((top) => ({
      queryKey: ["live-category", date, top.category],
      queryFn: () => api.get<PulseSamples>(`/api/live/samples?date=${date}&category=${top.category}&top=1`),
      staleTime: 30_000,
      retry: false,
    })),
  });
  const sampleNow = useSampleNow();
  if (tops.length === 0) return null;
  const series = results.flatMap((r) => r.data?.series ?? []).map((s) => ({ ...s, points: s.points.slice(-300) }));
  const withPoints = new Set(series.filter((s) => s.points.length > 0).map((s) => s.topic_id));
  const mode = modeOverride ?? (withPoints.size > 0 ? "live" : "scores");
  const scores = tops.map((t) => ({ topic_id: t.id, title: t.title, score: t.score }));
  return (
    <section aria-label="Live growth">
      <Eyebrow>growth of each category&apos;s number one</Eyebrow>
      <LiveChart series={series} mode={mode} scores={scores} onSelectTopic={onOpen} />
      <div style={{ display: "flex", gap: 8, marginTop: 8, alignItems: "center", flexWrap: "wrap" }}>
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
              onSuccess: () => {
                void queryClient.invalidateQueries({ queryKey: ["live-category"] });
              },
              onError: (error) => {
                toast({ tone: "bad", message: error.message });
              },
            });
          }}
        >
          sample now
        </button>
      </div>
      {tops
        .filter((t) => !withPoints.has(t.id))
        .map((t) => (
          <p key={t.category} className="form-hint">
            {t.category} #1 has no live numbers yet.
          </p>
        ))}
    </section>
  );
}
