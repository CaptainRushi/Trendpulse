/**
 * Live graph hooks (Doc 16 G4): top-today query, series query, SSE stream
 * with backoff reconnect + polling fallback + visibility pause, sample-now.
 */
import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";
import type { PulseSamples, PulseSeries, PulseTodayTop } from "../lib/api";

const STALE_MS = 30_000;

export function useTopToday(): ReturnType<typeof useQuery<PulseTodayTop>> {
  return useQuery({
    queryKey: ["pulse-top"],
    queryFn: () => api.get<PulseTodayTop>("/api/today/top"),
    staleTime: STALE_MS,
    retry: false,
  });
}

export function useLiveSeries(date: string | null): ReturnType<typeof useQuery<PulseSamples>> {
  return useQuery({
    queryKey: ["live-series", date],
    queryFn: () => api.get<PulseSamples>(`/api/live/samples?date=${date ?? ""}`),
    enabled: date !== null,
    staleTime: STALE_MS,
    retry: false,
  });
}

/** Merge one sample point into cached series without refetching (PULSE-23). */
export function mergeSamplePoint(
  samples: PulseSamples | undefined,
  point: { topic_id: string; t: string; index: number; total: number },
): PulseSamples | undefined {
  if (!samples) return samples;
  return {
    ...samples,
    series: samples.series.map((s) =>
      s.topic_id === point.topic_id && !s.points.some((p) => p.t === point.t)
        ? { ...s, points: [...s.points, { t: point.t, index: point.index, total: point.total }].slice(-300) }
        : s,
    ),
  };
}

export type StreamStatus = "live" | "reconnecting" | "polling" | "paused" | "idle";

interface StreamEvent {
  topic_id?: string;
  t?: string;
  index?: number;
  total?: number;
  date?: string;
}

const MAX_BACKOFF_MS = 30_000;
const POLL_MS = 30_000;

export function useLiveStream(date: string | null): { status: StreamStatus } {
  const client = useQueryClient();
  const [status, setStatus] = useState<StreamStatus>("idle");
  const statusRef = useRef(status);
  statusRef.current = status;

  useEffect(() => {
    if (date === null) return undefined;
    let source: EventSource | null = null;
    let backoff = 1000;
    let failures = 0;
    let pollTimer: ReturnType<typeof setInterval> | null | undefined = undefined;
    let reconnectTimer: ReturnType<typeof setTimeout> | null | undefined = undefined;
    let disposed = false;

    const apply = (type: string, data: StreamEvent): void => {
      if (type === "sample" && data.topic_id && data.t !== undefined && data.index !== undefined && data.total !== undefined) {
        const point = { topic_id: data.topic_id, t: data.t, index: data.index, total: data.total };
        client.setQueryData<PulseSamples | undefined>(["live-series", date], (old) => mergeSamplePoint(old, point));
      } else if (type === "top_changed") {
        void client.invalidateQueries({ queryKey: ["pulse-top"] });
        void client.invalidateQueries({ queryKey: ["live-series", date] });
      }
    };

    const startPolling = (): void => {
      if (disposed || pollTimer !== null) return;
      setStatus("polling");
      pollTimer = setInterval(() => {
        if (document.hidden) return;
        void client.invalidateQueries({ queryKey: ["live-series", date] });
      }, POLL_MS);
    };

    const connect = (): void => {
      if (disposed || typeof EventSource === "undefined") {
        startPolling();
        return;
      }
      if (document.hidden) {
        setStatus("paused");
        return;
      }
      try {
        source = new EventSource("/api/live/stream");
      } catch {
        startPolling();
        return;
      }
      setStatus(failures === 0 ? "live" : "reconnecting");
      const parseFrame = (event: MessageEvent): StreamEvent | null => {
        if (typeof event.data !== "string") return null;
        try {
          return JSON.parse(event.data) as StreamEvent;
        } catch {
          return null; // ignore malformed frames
        }
      };
      const onSample = (event: MessageEvent): void => {
        failures = 0;
        backoff = 1000;
        if (statusRef.current !== "live") setStatus("live");
        const data = parseFrame(event);
        if (data) apply("sample", data);
      };
      const onTop = (event: MessageEvent): void => {
        const data = parseFrame(event);
        if (data) apply("top_changed", data);
      };
      const onError = (): void => {
        source?.close();
        source = null;
        failures += 1;
        if (failures >= 3) {
          startPolling();
          return;
        }
        setStatus("reconnecting");
        reconnectTimer = setTimeout(() => {
          backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
          connect();
        }, backoff);
      };
      source.addEventListener("sample", onSample as EventListener);
      source.addEventListener("top_changed", onTop as EventListener);
      source.onerror = onError;
    };

    const onVisibility = (): void => {
      if (document.hidden) {
        source?.close();
        source = null;
        setStatus("paused");
      } else {
        if (pollTimer !== null) {
          clearInterval(pollTimer);
          pollTimer = null;
        }
        void client.invalidateQueries({ queryKey: ["live-series", date] });
        connect();
      }
    };
    document.addEventListener("visibilitychange", onVisibility);
    connect();
    return () => {
      disposed = true;
      document.removeEventListener("visibilitychange", onVisibility);
      source?.close();
      if (pollTimer !== null) clearInterval(pollTimer);
      if (reconnectTimer !== null) clearTimeout(reconnectTimer);
    };
  }, [date, client]);

  return { status };
}

export function useSampleNow(): ReturnType<
  typeof useMutation<{ status: string }, Error>
> {
  const client = useQueryClient();
  return useMutation({
    mutationFn: () => api.post<{ status: string }>("/api/live/sample-now", {}),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ["pulse-top"] });
      void client.invalidateQueries({ queryKey: ["live-series"] });
    },
  });
}

export type { PulseSeries };
