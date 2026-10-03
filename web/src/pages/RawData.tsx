import type React from "react";
import { useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useRaw, useSources } from "../hooks/useApi";
import { todayAppDate } from "../lib/format";
import { EmptyState, ErrorState, SkeletonGrid } from "../components/States";
import { Pill } from "../components/decode";

/**
 * Raw Data (§5.4): paginated server-side table (limit/offset) — no
 * virtualization library needed. Row click opens the snippet panel.
 */
const PAGE_SIZE = 25;

export function RawData(): React.JSX.Element {
  const [params, setParams] = useSearchParams();
  const [openId, setOpenId] = useState<string | null>(null);
  const sources = useSources();
  const date = params.get("date") ?? todayAppDate();
  const q = params.get("q") ?? "";
  const source = params.get("source") ?? "";
  const status = params.get("status") ?? "";
  const page = Math.max(0, Number(params.get("page") ?? "0") || 0);

  const raw = useRaw({
    ...(params.get("date") ? { date: params.get("date") as string } : {}),
    source: source ? [source] : [],
    status: status ? [status] : [],
    ...(q ? { q } : {}),
    limit: PAGE_SIZE,
    offset: page * PAGE_SIZE,
  });

  const set = (next: Record<string, string>): void => {
    const merged = new URLSearchParams(params);
    for (const [key, value] of Object.entries(next)) {
      if (value) merged.set(key, value);
      else merged.delete(key);
    }
    merged.delete("page");
    setParams(merged, { replace: true });
  };

  const totalPages = raw.data ? Math.max(1, Math.ceil(raw.data.total / PAGE_SIZE)) : 1;
  const open = raw.data?.items.find((item) => item.id === openId) ?? null;

  return (
    <div className="page">
      <h1 style={{ margin: 0 }}>Raw Data</h1>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
        <input
          className="input"
          type="date"
          aria-label="Raw date"
          value={date}
          onChange={(event) => {
            set({ date: event.target.value });
          }}
        />
        <input
          className="input"
          type="search"
          placeholder="Search raw items"
          aria-label="Search raw items"
          value={q}
          onChange={(event) => {
            set({ q: event.target.value });
          }}
        />
        <select
          className="select"
          aria-label="Source filter"
          value={source}
          onChange={(event) => {
            set({ source: event.target.value });
          }}
        >
          <option value="">All sources</option>
          {(sources.data ?? []).map((s) => (
            <option key={s.key} value={s.key}>
              {s.label}
            </option>
          ))}
        </select>
        <select
          className="select"
          aria-label="Status filter"
          value={status}
          onChange={(event) => {
            set({ status: event.target.value });
          }}
        >
          <option value="">Any status</option>
          <option value="pending">pending</option>
          <option value="sorted">sorted</option>
          <option value="discarded">discarded</option>
          <option value="sort_failed">sort_failed</option>
        </select>
        <a className="btn btn-ghost" href="/api/export/topics.csv" download>
          CSV export
        </a>
      </div>

      {raw.isPending ? <SkeletonGrid count={3} /> : null}
      {raw.isError ? <ErrorState error={raw.error} /> : null}
      {raw.data && raw.data.items.length === 0 ? (
        <EmptyState title="No raw items" hint="Adjust the date or filters." />
      ) : null}
      {raw.data && raw.data.items.length > 0 ? (
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th scope="col">Time</th>
                <th scope="col">Source</th>
                <th scope="col">Title</th>
                <th scope="col">Engagement</th>
                <th scope="col">Status</th>
              </tr>
            </thead>
            <tbody>
              {raw.data.items.map((item) => (
                <tr key={item.id}>
                  <td className="mono">{item.collected_at.slice(11, 16)}</td>
                  <td>{item.source}</td>
                  <td>
                    <button type="button" className="btn btn-ghost" onClick={() => { setOpenId(item.id); }}>
                      {item.title}
                    </button>
                  </td>
                  <td>{item.engagement_score ?? "—"}</td>
                  <td>
                    <Pill>{item.sort_status ?? "unknown"}</Pill>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 8 }}>
            <button
              type="button"
              className="btn btn-ghost"
              disabled={page === 0}
              onClick={() => {
                const next = new URLSearchParams(params);
                next.set("page", String(page - 1));
                setParams(next, { replace: true });
              }}
            >
              Prev
            </button>
            <span aria-label={`Page ${String(page + 1)} of ${String(totalPages)}`}>
              {page + 1} / {totalPages}
            </span>
            <button
              type="button"
              className="btn btn-ghost"
              disabled={page + 1 >= totalPages}
              onClick={() => {
                const next = new URLSearchParams(params);
                next.set("page", String(page + 1));
                setParams(next, { replace: true });
              }}
            >
              Next
            </button>
          </div>
        </div>
      ) : null}

      {open ? (        <section className="panel" aria-label="Raw item detail">
          <h2>{open.title}</h2>
          <p>{open.snippet || "No snippet."}</p>
          <div className="topic-meta">
            <span className="form-hint mono">{open.id}</span>
            <span className="form-hint mono">hash {open.content_hash.slice(0, 12)}</span>
            {open.merged_sources.length > 0 ? (
              <span className="form-hint">merged: {open.merged_sources.join(", ")}</span>
            ) : null}
          </div>
          <p>
            <a href={open.url} target="_blank" rel="noopener noreferrer">
              Open source
            </a>
          </p>
          <button type="button" className="btn btn-ghost" onClick={() => { setOpenId(null); }}>
            Close
          </button>
        </section>
      ) : null}
    </div>
  );
}
