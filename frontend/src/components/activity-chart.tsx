"use client";

import { useMemo, useRef, useState, type PointerEvent } from "react";

export type ActivityDay = { date: string; opened: number; closed: number };

const W = 720;
const H = 180;
const PAD = { left: 30, right: 58, top: 12, bottom: 22 };
const DAYS = 30;

function fillDays(sparse: ActivityDay[]): ActivityDay[] {
  const byDate = new Map(sparse.map((d) => [d.date, d]));
  const start = new Date();
  start.setUTCHours(0, 0, 0, 0);
  start.setUTCDate(start.getUTCDate() - (DAYS - 1));
  const out: ActivityDay[] = [];
  for (let i = 0; i < DAYS; i++) {
    const d = new Date(start);
    d.setUTCDate(start.getUTCDate() + i);
    const key = d.toISOString().slice(0, 10);
    out.push(byDate.get(key) ?? { date: key, opened: 0, closed: 0 });
  }
  return out;
}

function LegendSwatch({ color, label }: { color: string; label: string }) {
  return (
    <span className="flex items-center gap-1.5">
      <span
        className="inline-block h-2 w-2 rounded-full"
        style={{ background: color }}
      />
      <span className="text-(--color-text-muted)">{label}</span>
    </span>
  );
}

export function ActivityChart({ data }: { data: ActivityDay[] }) {
  const days = useMemo(() => fillDays(data), [data]);
  const [hover, setHover] = useState<number | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);

  const max = Math.max(1, ...days.map((d) => Math.max(d.opened, d.closed)));
  const x = (i: number) =>
    PAD.left + (i * (W - PAD.left - PAD.right)) / (days.length - 1);
  const y = (v: number) =>
    H - PAD.bottom - (v * (H - PAD.top - PAD.bottom)) / max;
  const path = (key: "opened" | "closed") =>
    days
      .map((d, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(d[key]).toFixed(1)}`)
      .join("");

  const last = days[days.length - 1];
  const yOpenedEnd = y(last.opened);
  const yClosedEndRaw = y(last.closed);
  const yClosedEnd =
    Math.abs(yOpenedEnd - yClosedEndRaw) < 12
      ? yClosedEndRaw >= yOpenedEnd
        ? yOpenedEnd + 12
        : yOpenedEnd - 12
      : yClosedEndRaw;

  const onMove = (e: PointerEvent<SVGSVGElement>) => {
    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect) return;
    const px = ((e.clientX - rect.left) / rect.width) * W;
    const i = Math.round(
      ((px - PAD.left) / (W - PAD.left - PAD.right)) * (days.length - 1),
    );
    setHover(Math.max(0, Math.min(days.length - 1, i)));
  };

  const hovered = hover === null ? null : days[hover];
  const tooltipLeftPct = hover === null ? 0 : Math.min((x(hover) / W) * 100, 78);

  return (
    <div className="relative">
      <div className="flex items-center gap-4 pb-2">
        <LegendSwatch color="var(--chart-opened)" label="Opened" />
        <LegendSwatch color="var(--chart-closed)" label="Closed" />
      </div>
      <svg
        ref={svgRef}
        viewBox={`0 0 ${W} ${H}`}
        className="w-full"
        role="img"
        aria-label="Issues opened and closed per day, last 30 days"
        onPointerMove={onMove}
        onPointerLeave={() => setHover(null)}
      >
        {[0, 0.5, 1].map((t) => (
          <g key={t}>
            <line
              x1={PAD.left}
              x2={W - PAD.right}
              y1={y(t * max)}
              y2={y(t * max)}
              stroke="var(--chart-grid)"
              strokeWidth="1"
            />
            <text
              x={PAD.left - 6}
              y={y(t * max) + 3}
              textAnchor="end"
              fontSize="9"
              fill="var(--color-text-muted)"
            >
              {Math.round(t * max)}
            </text>
          </g>
        ))}
        <text x={PAD.left} y={H - 6} fontSize="9" fill="var(--color-text-muted)">
          {days[0].date}
        </text>
        <text
          x={W - PAD.right}
          y={H - 6}
          textAnchor="end"
          fontSize="9"
          fill="var(--color-text-muted)"
        >
          {last.date}
        </text>
        <path
          d={path("opened")}
          fill="none"
          stroke="var(--chart-opened)"
          strokeWidth="2"
          strokeLinejoin="round"
        />
        <path
          d={path("closed")}
          fill="none"
          stroke="var(--chart-closed)"
          strokeWidth="2"
          strokeLinejoin="round"
        />
        <text
          x={W - PAD.right + 6}
          y={yOpenedEnd + 3}
          fontSize="10"
          fill="var(--color-text)"
        >
          Opened
        </text>
        <text
          x={W - PAD.right + 6}
          y={yClosedEnd + 3}
          fontSize="10"
          fill="var(--color-text)"
        >
          Closed
        </text>
        {hover !== null && hovered ? (
          <g>
            <line
              x1={x(hover)}
              x2={x(hover)}
              y1={PAD.top}
              y2={H - PAD.bottom}
              stroke="var(--chart-axis)"
              strokeWidth="1"
            />
            <circle
              cx={x(hover)}
              cy={y(hovered.opened)}
              r="4"
              fill="var(--chart-opened)"
              stroke="var(--color-surface)"
              strokeWidth="2"
            />
            <circle
              cx={x(hover)}
              cy={y(hovered.closed)}
              r="4"
              fill="var(--chart-closed)"
              stroke="var(--color-surface)"
              strokeWidth="2"
            />
          </g>
        ) : null}
      </svg>
      {hovered ? (
        <div
          className="pointer-events-none absolute top-8 z-10 rounded-lg border border-(--color-border) bg-(--color-surface) px-2.5 py-1.5 shadow-(--shadow-card)"
          style={{ left: `calc(${tooltipLeftPct}% + 8px)` }}
        >
          <div className="text-(--color-text-muted)">{hovered.date}</div>
          <div>
            {hovered.opened} opened · {hovered.closed} closed
          </div>
        </div>
      ) : null}
      <table className="sr-only">
        <caption>Issues opened and closed per day, last 30 days</caption>
        <thead>
          <tr>
            <th>Date</th>
            <th>Opened</th>
            <th>Closed</th>
          </tr>
        </thead>
        <tbody>
          {days.map((d) => (
            <tr key={d.date}>
              <td>{d.date}</td>
              <td>{d.opened}</td>
              <td>{d.closed}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
