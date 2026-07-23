"use client";

import Link from "next/link";
import { SERIES_VAR, seriesOfType } from "../../app/plan/matrix/matrix-types";
import type { MinimapPoint } from "./types";

const W = 300;
const H = 190;
const QUADS = [
  { key: "schedule", x: 0, y: 0, cx: 0, cy: 0 },
  { key: "dofirst", x: W / 2, y: 0, cx: 1, cy: 0 },
  { key: "reconsider", x: 0, y: H / 2, cx: 0, cy: 1 },
  { key: "delegate", x: W / 2, y: H / 2, cx: 1, cy: 1 },
] as const;

export function MatrixMinimap({ points }: { points: MinimapPoint[] }) {
  return (
    <Link
      href="/plan/matrix"
      data-testid="matrix-minimap"
      className="block rounded-[14px] border border-(--color-border) bg-(--color-surface) px-4 py-3 shadow-(--shadow-card) transition-all hover:border-(--color-primary)"
    >
      <div className="flex items-baseline justify-between pb-2">
        <span className="text-[10px] font-semibold tracking-[0.08em] text-(--color-text-muted) uppercase">
          Matrix
        </span>
        <span className="text-(--color-text-muted)">{points.length} plotted</span>
      </div>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="w-full"
        role="img"
        aria-label="Priority matrix thumbnail"
      >
        <defs>
          {QUADS.map((q) => (
            <radialGradient
              key={q.key}
              id={`mini-quad-${q.key}`}
              cx={q.cx}
              cy={q.cy}
              r={1.15}
            >
              <stop offset="0" stopColor={`var(--quad-${q.key}-strong)`} />
              <stop offset="1" stopColor={`var(--quad-${q.key}-strong)`} stopOpacity={0} />
            </radialGradient>
          ))}
        </defs>
        {QUADS.map((q) => (
          <rect
            key={q.key}
            x={q.x}
            y={q.y}
            width={W / 2}
            height={H / 2}
            fill={`url(#mini-quad-${q.key})`}
          />
        ))}
        {points.map((point, idx) => (
          <circle
            key={idx}
            cx={(point.u / 100) * W}
            cy={H - (point.i / 100) * H}
            r={2.2 + point.estimate * 0.55}
            fill={SERIES_VAR[seriesOfType(point.type)]}
            opacity={0.85}
          />
        ))}
        {points.length === 0 ? (
          <text
            x={W / 2}
            y={H / 2}
            textAnchor="middle"
            fill="var(--color-text-muted)"
            fontSize="11"
          >
            No prioritized issues yet
          </text>
        ) : null}
      </svg>
    </Link>
  );
}
