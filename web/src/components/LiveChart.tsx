/**
 * LiveChart (Doc 16 G4): pure SVG growth-index chart, no charting framework.
 * Hand-rolled linear scales; series cap 300 points (caller slices).
 */
import { useState } from "react";
import type { PulseSeries } from "../lib/api";
import tokens from "../styles/tokens.json";

/** Stroke palette from the token source (W-23): forest, violet, info, warn, grey. */
export const SERIES_COLORS = [tokens.forest, tokens.violet, tokens.info, tokens.warn, tokens.muted];
const SERIES_DASHES = ["", "", "5 3", "2 3", "8 3"];

const W = 640;
const H = 260;
const PAD = { l: 44, r: 132, t: 12, b: 28 };

export interface ScoreBar {
  topic_id: string;
  title: string;
  score: number;
}

interface ChartProps {
  series: PulseSeries[];
  mode: "live" | "scores";
  scores?: ScoreBar[];
  onSelectTopic?: (topicId: string) => void;
}

function timeTicks(min: number, max: number): number[] {
  if (max <= min) return [min];
  const step = (max - min) / 4;
  return [0, 1, 2, 3, 4].map((i) => min + step * i);
}

function fmtTime(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/** End labels share ~80 px: rank + short title keeps them inside the viewBox. */
function shortLabel(title: string, seriesIndex: number): string {
  const max = 14;
  const short = title.length > max ? `${title.slice(0, max - 1)}…` : title;
  return `${String(seriesIndex + 1)}. ${short}`;
}

export function LiveChart({ series, mode, scores = [], onSelectTopic }: ChartProps): React.JSX.Element {
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const [focusIdx, setFocusIdx] = useState<number>(-1);

  if (mode === "scores") {
    const max = Math.max(1, ...scores.map((s) => s.score));
    return (
      <div role="img" aria-label={`trend scores for ${String(scores.length)} topics`}>
        {scores.map((s) => (
          <div key={s.topic_id} className="score-bar-row">
            <span className="score-bar-label">{s.title}</span>
            <span className="score-bar-track">
              <span className="score-bar-fill" style={{ width: `${String(Math.round((s.score / max) * 100))}%` }} />
            </span>
            <span className="num">{s.score}</span>
          </div>
        ))}
      </div>
    );
  }

  const visible = series.filter((s) => !hidden.has(s.topic_id) && s.points.length > 0);
  const allT = visible.flatMap((s) => s.points.map((p) => Date.parse(p.t)));
  const tMin = allT.length > 0 ? Math.min(...allT) : 0;
  const tMax = allT.length > 0 ? Math.max(...allT) : 1;
  const allV = visible.flatMap((s) => s.points.map((p) => p.index));
  const vMin = Math.min(100, ...(allV.length > 0 ? allV : [100]));
  const vMax = Math.max(100, ...(allV.length > 0 ? allV : [100]));
  const spanV = vMax - vMin || 1;

  const x = (t: number): number => PAD.l + ((t - tMin) / Math.max(1, tMax - tMin)) * (W - PAD.l - PAD.r);
  const y = (v: number): number => PAD.t + (1 - (v - vMin) / spanV) * (H - PAD.t - PAD.b);

  const summary = visible.map((s) => {
    const last = s.points[s.points.length - 1];
    const pct = last ? Math.round(last.index - 100) : 0;
    return `${s.title} ${pct >= 0 ? "+" : ""}${String(pct)} percent`;
  }).join("; ");

  const firstSeries = visible.length > 0 ? visible[0] : undefined;
  const focusPoint =
    focusIdx >= 0 && firstSeries && firstSeries.points.length > 0
      ? firstSeries.points[Math.min(focusIdx, firstSeries.points.length - 1)]
      : undefined;

  return (
    <div className="live-chart">
      <div className="chip-row" role="group" aria-label="Toggle series">
        {series.map((s) => (
          <button
            key={s.topic_id}
            type="button"
            className="chip"
            aria-pressed={!hidden.has(s.topic_id)}
            data-active={!hidden.has(s.topic_id) || undefined}
            onClick={() => {
              setHidden((prev) => {
                const next = new Set(prev);
                if (next.has(s.topic_id)) next.delete(s.topic_id);
                else next.add(s.topic_id);
                return next;
              });
            }}
          >
            {s.title}
          </button>
        ))}
      </div>
      <svg
        viewBox={`0 0 ${String(W)} ${String(H)}`}
        width="100%"
        role="img"
        aria-label={visible.length === 0 ? "no live data yet" : `growth since baseline: ${summary}`}
        tabIndex={0}
        onKeyDown={(event) => {
          const len = visible[0]?.points.length ?? 0;
          if (event.key === "ArrowRight") setFocusIdx((i) => Math.min(len - 1, i + 1));
          if (event.key === "ArrowLeft") setFocusIdx((i) => Math.max(0, i - 1));
        }}
      >
        {[0.25, 0.5, 0.75].map((f) => (
          <line key={f} x1={PAD.l} x2={W - PAD.r} y1={PAD.t + f * (H - PAD.t - PAD.b)} y2={PAD.t + f * (H - PAD.t - PAD.b)} className="grid-line" />
        ))}
        <line x1={PAD.l} x2={W - PAD.r} y1={y(100)} y2={y(100)} className="baseline-line" />
        <text x={PAD.l - 6} y={y(100) + 4} textAnchor="end" className="tick-label">100</text>
        {vMax - vMin > 0.005 ? (
          <>
            <text x={PAD.l - 6} y={y(vMax) + 4} textAnchor="end" className="tick-label">{vMax.toFixed(1)}</text>
            <text x={PAD.l - 6} y={y(vMin) + 4} textAnchor="end" className="tick-label">{vMin.toFixed(1)}</text>
          </>
        ) : null}
        {timeTicks(tMin, tMax).map((t) => (
          <text key={t} x={x(t)} y={H - 8} textAnchor="middle" className="tick-label">{fmtTime(t)}</text>
        ))}
        {visible.map((s, si) => {
          const d = s.points.map((p, i) => `${i === 0 ? "M" : "L"}${x(Date.parse(p.t)).toFixed(1)},${y(p.index).toFixed(1)}`).join(" ");
          const last = s.points[s.points.length - 1];
          const color = SERIES_COLORS[si % SERIES_COLORS.length] ?? tokens.muted;
          const dash = SERIES_DASHES[si % SERIES_DASHES.length] ?? "";
          return (
            <g key={s.topic_id}>
              {si === 0 && last ? (
                <path d={`${d}L${x(Date.parse(last.t)).toFixed(1)},${y(vMin).toFixed(1)}L${x(Date.parse(s.points[0]?.t ?? last.t)).toFixed(1)},${y(vMin).toFixed(1)}Z`} className="series-area" />
              ) : null}
              <path d={d} fill="none" stroke={color} strokeWidth={si === 0 ? 2.5 : 2} strokeDasharray={dash || undefined} />
              {s.points.map((p) => (
                <circle key={p.t} cx={x(Date.parse(p.t))} cy={y(p.index)} r={3.5} fill={color} stroke={tokens.panel} strokeWidth={1.5}>
                  <title>{`${s.title} ${fmtTime(Date.parse(p.t))}: index ${p.index.toFixed(1)}, total ${String(p.total)}`}</title>
                </circle>
              ))}
              {last ? (
                <text
                  x={W - PAD.r + 8}
                  y={y(last.index) + (si - (visible.length - 1) / 2) * 13}
                  aria-label={`${s.title} ${Math.round(last.index - 100) >= 0 ? "+" : ""}${String(Math.round(last.index - 100))} percent`}
                  className="end-label"
                  onClick={() => onSelectTopic?.(s.topic_id)}
                  onKeyDown={(e) => { if (e.key === "Enter") onSelectTopic?.(s.topic_id); }}
                  tabIndex={onSelectTopic ? 0 : undefined}
                  role={onSelectTopic ? "link" : undefined}
                >
                  {shortLabel(s.title, si)} {Math.round(last.index - 100) >= 0 ? "+" : ""}{Math.round(last.index - 100)}%
                </text>
              ) : null}
            </g>
          );
        })}
        {focusPoint ? (
          <g>
            <line x1={x(Date.parse(focusPoint.t))} x2={x(Date.parse(focusPoint.t))} y1={PAD.t} y2={H - PAD.b} className="crosshair-line" />
            <circle cx={x(Date.parse(focusPoint.t))} cy={y(focusPoint.index)} r={4} className="crosshair-dot" />
          </g>
        ) : null}
      </svg>
      {focusPoint ? (
        <div className="chart-tooltip" role="status">
          {fmtTime(Date.parse(focusPoint.t))} · index {focusPoint.index.toFixed(1)} · total {focusPoint.total}
        </div>
      ) : null}
      <table className="visually-hidden">
        <caption>growth index points</caption>
        <tbody>
          {visible.map((s) =>
            s.points.map((p) => (
              <tr key={`${s.topic_id}-${p.t}`}>
                <td>{s.title}</td>
                <td>{p.t}</td>
                <td>{p.index}</td>
                <td>{p.total}</td>
              </tr>
            )),
          )}
        </tbody>
      </table>
    </div>
  );
}

