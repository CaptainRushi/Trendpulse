/** URL-synced filter state (design §5.1: filters persist in the query string). */
import { useSearchParams } from "react-router-dom";

function getList(params: URLSearchParams, key: string): string[] {
  return params.getAll(key).filter((v) => v.length > 0);
}

export interface TopicFilters {
  q: string;
  category: string[];
  source: string[];
  momentum: string[];
  minScore: number | undefined;
  sort: string;
}

const DEFAULT_SORT = "score";

export function useTopicFilters(): [TopicFilters, (next: Partial<TopicFilters>) => void, () => void] {
  const [params, setParams] = useSearchParams();
  const minScoreRaw = params.get("min_score");
  const filters: TopicFilters = {
    q: params.get("q") ?? "",
    category: getList(params, "category"),
    source: getList(params, "source"),
    momentum: getList(params, "momentum"),
    minScore:
      minScoreRaw !== null && minScoreRaw !== "" && Number.isFinite(Number(minScoreRaw))
        ? Number(minScoreRaw)
        : undefined,
    sort: params.get("sort") ?? DEFAULT_SORT,
  };
  const update = (next: Partial<TopicFilters>): void => {
    const merged = { ...filters, ...next };
    const nextParams = new URLSearchParams();
    if (merged.q) nextParams.set("q", merged.q);
    for (const c of merged.category) nextParams.append("category", c);
    for (const s of merged.source) nextParams.append("source", s);
    for (const m of merged.momentum) nextParams.append("momentum", m);
    if (merged.minScore !== undefined) nextParams.set("min_score", String(merged.minScore));
    if (merged.sort !== DEFAULT_SORT) nextParams.set("sort", merged.sort);
    setParams(nextParams, { replace: true });
  };
  const clear = (): void => {
    setParams(new URLSearchParams(), { replace: true });
  };
  return [filters, update, clear];
}
