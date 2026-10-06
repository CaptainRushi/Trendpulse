/** TanStack Query hooks over the typed client. Queries stay fresh 30s. */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";
import type {
  Digest,
  Health,
  RawItem,
  RawResponse,
  RunDetail,
  RunRow,
  SettingView,
  SourceEntry,
  TrendsResponse,
} from "../lib/api";

const STALE_MS = 30_000;

export function useHealth(): ReturnType<typeof useQuery<Health>> {
  return useQuery({ queryKey: ["health"], queryFn: () => api.get<Health>("/api/health"), staleTime: STALE_MS });
}

export interface TrendFilters {
  date: string;
  scope?: string;
  category: string[];
  source: string[];
  momentum: string[];
  minScore?: number;
  q?: string;
  sort: string;
  limit: number;
  offset: number;
}

function trendParams(filters: TrendFilters): string {
  const params = new URLSearchParams({ date: filters.date, sort: filters.sort });
  if (filters.scope && filters.scope !== "all") params.set("scope", filters.scope);
  for (const c of filters.category) params.append("category", c);
  for (const s of filters.source) params.append("source", s);
  for (const m of filters.momentum) params.append("momentum", m);
  if (filters.minScore !== undefined) params.set("min_score", String(filters.minScore));
  if (filters.q) params.set("q", filters.q);
  params.set("limit", String(filters.limit));
  params.set("offset", String(filters.offset));
  return params.toString();
}

export function useTrends(filters: TrendFilters): ReturnType<typeof useQuery<TrendsResponse>> {
  return useQuery({
    queryKey: ["trends", filters],
    queryFn: () => api.get<TrendsResponse>(`/api/trends?${trendParams(filters)}`),
    staleTime: STALE_MS,
  });
}

export function useDigest(date: string): ReturnType<typeof useQuery<Digest>> {
  return useQuery({
    queryKey: ["digest", date],
    queryFn: () => api.get<Digest>(`/api/digest?date=${date}`),
    staleTime: STALE_MS,
    retry: false,
  });
}

export interface RawFilters {
  date?: string;
  source: string[];
  status: string[];
  q?: string;
  limit: number;
  offset: number;
}

export function useRaw(filters: RawFilters): ReturnType<typeof useQuery<RawResponse>> {
  return useQuery({
    queryKey: ["raw", filters],
    queryFn: () => {
      const params = new URLSearchParams();
      if (filters.date) params.set("date", filters.date);
      for (const s of filters.source) params.append("source", s);
      for (const s of filters.status) params.append("status", s);
      if (filters.q) params.set("q", filters.q);
      params.set("limit", String(filters.limit));
      params.set("offset", String(filters.offset));
      return api.get<RawResponse>(`/api/raw?${params.toString()}`);
    },
    staleTime: STALE_MS,
  });
}

export function useTopicEvidence(topicId: string | null): ReturnType<typeof useQuery<{ topic: unknown; evidence: RawItem[] }>> {
  return useQuery({
    queryKey: ["topic", topicId],
    queryFn: () => api.get<{ topic: unknown; evidence: RawItem[] }>(`/api/trends/${topicId ?? ""}`),
    enabled: topicId !== null,
    staleTime: 60_000,
  });
}

export function useDates(): ReturnType<typeof useQuery<{ dates: string[] }>> {
  return useQuery({
    queryKey: ["dates"],
    queryFn: () => api.get<{ dates: string[] }>("/api/dates"),
    staleTime: STALE_MS,
  });
}

export function useSources(): ReturnType<typeof useQuery<SourceEntry[]>> {
  return useQuery({
    queryKey: ["sources"],
    queryFn: () => api.get<SourceEntry[]>("/api/sources"),
    staleTime: STALE_MS,
  });
}

export function useRuns(limit = 20, offset = 0): ReturnType<typeof useQuery<{ runs: RunRow[]; total: number }>> {
  return useQuery({
    queryKey: ["runs", limit, offset],
    queryFn: () => api.get<{ runs: RunRow[]; total: number }>(`/api/runs?limit=${String(limit)}&offset=${String(offset)}`),
    staleTime: 10_000,
  });
}

export function useRun(runId: string | null): ReturnType<typeof useQuery<RunDetail>> {
  return useQuery({
    queryKey: ["run", runId],
    queryFn: () => api.get<RunDetail>(`/api/runs/${runId ?? ""}`),
    enabled: runId !== null,
    staleTime: 5_000,
  });
}

export function useSettings(): ReturnType<typeof useQuery<{ settings: Record<string, SettingView> }>> {
  return useQuery({
    queryKey: ["settings"],
    queryFn: () => api.get<{ settings: Record<string, SettingView> }>("/api/settings"),
    staleTime: STALE_MS,
  });
}

export function useSheetLink(): ReturnType<typeof useQuery<{ spreadsheet_url: string; tabs: Record<string, string> }>> {
  return useQuery({
    queryKey: ["sheet-link"],
    queryFn: () => api.get<{ spreadsheet_url: string; tabs: Record<string, string> }>("/api/sheets/link"),
    staleTime: 5 * 60_000,
    retry: false,
  });
}

export function useStartRun(): ReturnType<typeof useMutation<{ run_id: string }, Error, Record<string, unknown>>> {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body: Record<string, unknown>) => api.post<{ run_id: string }>("/api/runs", body),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ["runs"] });
    },
  });
}

export function useRetryRun(): ReturnType<typeof useMutation<{ run_id: string }, Error, { runId: string; fromStage?: string }>> {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (args: { runId: string; fromStage?: string }) =>
      api.post<{ run_id: string }>(
        `/api/runs/${args.runId}/retry`,
        args.fromStage ? { from_stage: args.fromStage } : {},
      ),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ["runs"] });
    },
  });
}

export function useSyncSheets(): ReturnType<typeof useMutation<{ ok: boolean }, Error, void>> {
  const client = useQueryClient();
  return useMutation({
    mutationFn: () => api.post<{ ok: boolean }>("/api/sheets/sync"),
    onSuccess: () => {
      void client.invalidateQueries();
    },
  });
}
