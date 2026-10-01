import type React from "react";
import { scoreColor } from "../lib/format";

/** Score ring: SVG circle with the number inside (§5.1). Text alternative via role+label. */
export function ScoreRing({ score, size = 44 }: { score: number; size?: number }): React.JSX.Element {
  const stroke = 4;
  const radius = (size - stroke) / 2;
  const circumference = 2 * Math.PI * radius;
  const filled = (Math.max(0, Math.min(100, score)) / 100) * circumference;
  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${String(size)} ${String(size)}`}
      role="img"
      aria-label={`Trend score ${String(score)} out of 100`}
    >
      <circle cx={size / 2} cy={size / 2} r={radius} fill="none" stroke="var(--border)" strokeWidth={stroke} />
      <circle
        cx={size / 2}
        cy={size / 2}
        r={radius}
        fill="none"
        stroke={scoreColor(score)}
        strokeWidth={stroke}
        strokeLinecap="round"
        strokeDasharray={`${String(filled)} ${String(circumference)}`}
        transform={`rotate(-90 ${String(size / 2)} ${String(size / 2)})`}
      />
      <text
        x="50%"
        y="50%"
        dominantBaseline="central"
        textAnchor="middle"
        fill="var(--text)"
        fontSize={size * 0.32}
        fontWeight={700}
      >
        {score}
      </text>
    </svg>
  );
}
