"use client";

import { useMemo, useRef, useState, type CSSProperties, type PointerEvent } from "react";
import { PLOT, radiusOf, resolveCollisions, VIEW_H, VIEW_W, xOf, yOf } from "./matrix-layout";
import {
  SERIES_VAR,
  seriesOf,
  type PlottedItem,
} from "./matrix-types";
import { PinGlyph } from "./pin-glyph";

const PLOT_W = PLOT.right - PLOT.left; // 790
const PLOT_H = PLOT.bottom - PLOT.top; // 496
const DRAG_THRESHOLD_PX = 3;

type DragState = {
  issueId: number;
  startX: number;
  startY: number;
  moved: boolean;
  u: number;
  i: number;
};

const QUADRANTS = [
  { key: "schedule", x: PLOT.left, y: PLOT.top, cornerX: 0, cornerY: 0, label: "SCHEDULE", lx: PLOT.left + 12, ly: PLOT.top + 20 },
  { key: "dofirst", x: PLOT.left + PLOT_W / 2, y: PLOT.top, cornerX: 1, cornerY: 0, label: "DO FIRST", lx: PLOT.right - 12, ly: PLOT.top + 20, anchor: "end" as const },
  { key: "delegate", x: PLOT.left + PLOT_W / 2, y: PLOT.top + PLOT_H / 2, cornerX: 1, cornerY: 1, label: "DELEGATE / QUICK WINS", lx: PLOT.right - 12, ly: PLOT.bottom - 10, anchor: "end" as const },
  { key: "reconsider", x: PLOT.left, y: PLOT.top + PLOT_H / 2, cornerX: 0, cornerY: 1, label: "RECONSIDER", lx: PLOT.left + 12, ly: PLOT.bottom - 10 },
];

export function MatrixChart({
  plotted,
  selectedId,
  onSelect,
  onPin,
  onHover,
}: {
  plotted: PlottedItem[];
  selectedId: number | null;
  onSelect: (id: number | null) => void;
  onPin: (issueId: number, urgency: number, importance: number) => void;
  onHover: (item: PlottedItem | null, cx: number, cy: number) => void;
}) {
  const svgRef = useRef<SVGSVGElement | null>(null);
  const [drag, setDrag] = useState<DragState | null>(null);
  const nudges = useMemo(() => resolveCollisions(plotted), [plotted]);
  const popRank = useMemo(() => {
    const order = [...plotted].sort((a, b) => b.u + b.i - (a.u + a.i));
    return new Map(order.map((item, index) => [item.issue_id, index]));
  }, [plotted]);

  const clientToChart = (e: PointerEvent): { u: number; i: number } => {
    const rect = svgRef.current!.getBoundingClientRect();
    const x = ((e.clientX - rect.left) / rect.width) * VIEW_W;
    const y = ((e.clientY - rect.top) / rect.height) * VIEW_H;
    const u = Math.max(0, Math.min(100, ((x - PLOT.left) / PLOT_W) * 100));
    const i = Math.max(0, Math.min(100, ((PLOT.bottom - y) / PLOT_H) * 100));
    return { u, i };
  };

  const onBubbleDown = (item: PlottedItem) => (e: PointerEvent<SVGGElement>) => {
    try {
      (e.currentTarget as Element & { setPointerCapture(id: number): void }).setPointerCapture(
        e.pointerId,
      );
    } catch {
      // pointer capture is best-effort; drag still works without it
    }
    setDrag({
      issueId: item.issue_id,
      startX: e.clientX,
      startY: e.clientY,
      moved: false,
      u: item.u,
      i: item.i,
    });
  };

  const onBubbleMove = (e: PointerEvent<SVGGElement>) => {
    if (!drag) return;
    const dx = e.clientX - drag.startX;
    const dy = e.clientY - drag.startY;
    const moved =
      drag.moved || Math.hypot(dx, dy) > DRAG_THRESHOLD_PX;
    const { u, i } = clientToChart(e);
    setDrag({ ...drag, moved, u, i });
  };

  const onBubbleUp = (item: PlottedItem) => (e: PointerEvent<SVGGElement>) => {
    if (!drag || drag.issueId !== item.issue_id) return;
    if (drag.moved) {
      const { u, i } = clientToChart(e);
      onPin(item.issue_id, Math.round(u * 10) / 10, Math.round(i * 10) / 10);
    } else {
      onSelect(selectedId === item.issue_id ? null : item.issue_id);
    }
    setDrag(null);
  };

  return (
    <div className="rounded-[14px] border border-(--color-border) bg-(--color-surface) p-3 shadow-(--shadow-card)">
      <svg
        ref={svgRef}
        viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
        className="w-full touch-none select-none"
        aria-label="Priority matrix: urgency by importance. Bubbles are focusable; press Enter to select."
        data-testid="matrix-chart"
      >
        <defs>
          {QUADRANTS.map((q) => (
            <radialGradient
              key={q.key}
              id={`quad-grad-${q.key}`}
              cx={q.cornerX}
              cy={q.cornerY}
              r={1.15}
            >
              <stop offset="0" stopColor={`var(--quad-${q.key}-strong)`} />
              <stop offset="1" stopColor={`var(--quad-${q.key}-strong)`} stopOpacity={0} />
            </radialGradient>
          ))}
          <filter id="select-glow" x="-60%" y="-60%" width="220%" height="220%">
            <feGaussianBlur stdDeviation="3.2" />
          </filter>
        </defs>
        <g className="matrix-washes">
          {QUADRANTS.map((q) => (
            <g key={q.label}>
              <rect x={q.x} y={q.y} width={PLOT_W / 2} height={PLOT_H / 2} fill={`url(#quad-grad-${q.key})`} />
              <text
                x={q.lx}
                y={q.ly}
                textAnchor={q.anchor ?? "start"}
                fill={`var(--quad-${q.key}-label)`}
                fontSize="11"
                fontWeight="600"
                letterSpacing="0.08em"
              >
                {q.label}
              </text>
            </g>
          ))}
        </g>

        {/* grid + axes */}
        <line x1={PLOT.left} y1={PLOT.top + PLOT_H / 2} x2={PLOT.right} y2={PLOT.top + PLOT_H / 2} stroke="var(--chart-grid)" strokeDasharray="3 3" />
        <line x1={PLOT.left + PLOT_W / 2} y1={PLOT.top} x2={PLOT.left + PLOT_W / 2} y2={PLOT.bottom} stroke="var(--chart-grid)" strokeDasharray="3 3" />
        <line x1={PLOT.left} y1={PLOT.bottom} x2={PLOT.right} y2={PLOT.bottom} stroke="var(--chart-axis)" />
        <line x1={PLOT.left} y1={PLOT.top} x2={PLOT.left} y2={PLOT.bottom} stroke="var(--chart-axis)" />
        {[0, 50, 100].map((tick) => (
          <g key={tick}>
            <text x={xOf(tick)} y={VIEW_H - 24} textAnchor="middle" fill="var(--color-text-muted)" fontSize="11">
              {tick}
            </text>
            <text x={PLOT.left - 10} y={yOf(tick) + 4} textAnchor="end" fill="var(--color-text-muted)" fontSize="11">
              {tick}
            </text>
          </g>
        ))}
        <text x={PLOT.right} y={VIEW_H - 6} textAnchor="end" fill="var(--color-text-muted)" fontSize="11">
          Urgency →
        </text>
        <text
          transform={`translate(14 ${PLOT.bottom}) rotate(-90)`}
          fill="var(--color-text-muted)"
          fontSize="11"
        >
          Importance →
        </text>

        {plotted.map((item) => {
          const dragging = drag?.issueId === item.issue_id && drag.moved;
          const u = dragging ? drag.u : item.u;
          const i = dragging ? drag.i : item.i;
          const nudge = dragging ? undefined : nudges.get(item.issue_id);
          const cx = xOf(u) + (nudge?.dx ?? 0);
          const cy = yOf(i) + (nudge?.dy ?? 0);
          const r = radiusOf(item.estimate);
          const color = SERIES_VAR[seriesOf(item)];
          const isSelected = selectedId === item.issue_id;
          return (
            <g
              key={item.issue_id}
              data-testid={`bubble-${item.number}`}
              className="matrix-bubble cursor-grab"
              style={{ "--pop-delay": `${Math.min((popRank.get(item.issue_id) ?? 0) * 70, 1400)}ms` } as CSSProperties}
              role="button"
              tabIndex={0}
              aria-label={`Issue #${item.number}: ${item.title}`}
              aria-pressed={isSelected}
              onPointerDown={onBubbleDown(item)}
              onPointerMove={onBubbleMove}
              onPointerUp={onBubbleUp(item)}
              onPointerCancel={() => setDrag(null)}
              onPointerEnter={() => onHover(item, cx, cy)}
              onPointerLeave={() => onHover(null, 0, 0)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  onSelect(selectedId === item.issue_id ? null : item.issue_id);
                }
              }}
            >
              {isSelected ? (
                <circle
                  cx={cx}
                  cy={cy}
                  r={r + 1}
                  fill="none"
                  stroke="var(--color-primary)"
                  strokeWidth={5}
                  opacity={0.35}
                  filter="url(#select-glow)"
                />
              ) : null}
              <circle
                cx={cx}
                cy={cy}
                r={r}
                fill={color}
                fillOpacity={0.85}
                stroke={color}
                strokeWidth={1.5}
              />
              <text
                x={cx}
                y={cy + 3.5}
                textAnchor="middle"
                fontSize={Math.max(8.5, Math.min(11, r * 0.85))}
                fontWeight="500"
                fill="var(--color-text)"
                stroke="var(--color-surface)"
                strokeWidth="1.5"
                paintOrder="stroke"
                style={{ fontVariantNumeric: "tabular-nums", pointerEvents: "none" }}
              >
                {item.number}
              </text>
              {item.pinned ? (
                <g
                  data-testid={`pin-badge-${item.number}`}
                  transform={`translate(${cx + r * 0.72} ${cy - r * 0.72})`}
                >
                  <circle r={5.5} fill="var(--color-primary)" stroke="var(--color-surface)" strokeWidth={1.2} />
                  <g transform="rotate(45)">
                    <line y1={0.6} y2={3.4} stroke="#fff" strokeWidth={1.2} />
                    <circle cy={-1.2} r={1.9} fill="#fff" />
                  </g>
                </g>
              ) : null}
            </g>
          );
        })}
      </svg>

      <div className="flex items-center gap-4 px-2 pt-2" data-testid="matrix-legend">
        {(["bug", "feature", "debt", "other"] as const).map((series) => (
          <span key={series} className="flex items-center gap-1.5 text-(--color-text-muted)">
            <span
              className="inline-block h-2.5 w-2.5 rounded-full"
              style={{ background: SERIES_VAR[series] }}
            />
            {series}
          </span>
        ))}
        <span className="grow" />
        <span className="flex items-center gap-1 text-(--color-text-muted)">
          size = effort · <PinGlyph className="inline-block h-3 w-3" /> = pinned
        </span>
      </div>
    </div>
  );
}
