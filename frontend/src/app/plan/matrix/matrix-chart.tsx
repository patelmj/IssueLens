"use client";

import { useRef, useState, type PointerEvent } from "react";
import {
  SERIES_VAR,
  seriesOf,
  type PlottedItem,
} from "./matrix-types";

export const VIEW_W = 860;
export const VIEW_H = 560;
export const PLOT = { left: 52, right: 842, top: 18, bottom: 514 };
const PLOT_W = PLOT.right - PLOT.left; // 790
const PLOT_H = PLOT.bottom - PLOT.top; // 496
const DRAG_THRESHOLD_PX = 3;

export function xOf(u: number): number {
  return PLOT.left + (u / 100) * PLOT_W;
}
export function yOf(i: number): number {
  return PLOT.bottom - (i / 100) * PLOT_H;
}
export function radiusOf(estimate: number): number {
  return 8 + estimate * 2.1;
}

type DragState = {
  issueId: number;
  startX: number;
  startY: number;
  moved: boolean;
  u: number;
  i: number;
};

const QUADRANT_RECTS = [
  { x: PLOT.left, y: PLOT.top, w: PLOT_W / 2, h: PLOT_H / 2, fill: "var(--quad-schedule)", label: "SCHEDULE", lx: PLOT.left + 12, ly: PLOT.top + 20 },
  { x: PLOT.left + PLOT_W / 2, y: PLOT.top, w: PLOT_W / 2, h: PLOT_H / 2, fill: "var(--quad-dofirst)", label: "DO FIRST", lx: PLOT.right - 12, ly: PLOT.top + 20, anchor: "end" as const },
  { x: PLOT.left + PLOT_W / 2, y: PLOT.top + PLOT_H / 2, w: PLOT_W / 2, h: PLOT_H / 2, fill: "var(--quad-delegate)", label: "DELEGATE / QUICK WINS", lx: PLOT.right - 12, ly: PLOT.bottom - 10, anchor: "end" as const },
  { x: PLOT.left, y: PLOT.top + PLOT_H / 2, w: PLOT_W / 2, h: PLOT_H / 2, fill: "var(--quad-reconsider)", label: "RECONSIDER", lx: PLOT.left + 12, ly: PLOT.bottom - 10 },
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
        role="img"
        aria-label="Priority matrix: urgency by importance"
        data-testid="matrix-chart"
      >
        {QUADRANT_RECTS.map((q) => (
          <g key={q.label}>
            <rect x={q.x} y={q.y} width={q.w} height={q.h} fill={q.fill} />
            <text
              x={q.lx}
              y={q.ly}
              textAnchor={q.anchor ?? "start"}
              fill="var(--color-text-muted)"
              fontSize="11"
              fontWeight="600"
              letterSpacing="0.08em"
            >
              {q.label}
            </text>
          </g>
        ))}

        {/* grid + axes */}
        <line x1={PLOT.left} y1={PLOT.top + PLOT_H / 2} x2={PLOT.right} y2={PLOT.top + PLOT_H / 2} stroke="var(--chart-grid)" />
        <line x1={PLOT.left + PLOT_W / 2} y1={PLOT.top} x2={PLOT.left + PLOT_W / 2} y2={PLOT.bottom} stroke="var(--chart-grid)" />
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
        <text x={14} y={PLOT.top + 10} fill="var(--color-text-muted)" fontSize="11">
          Importance ↑
        </text>

        {plotted.map((item) => {
          const dragging = drag?.issueId === item.issue_id && drag.moved;
          const u = dragging ? drag.u : item.u;
          const i = dragging ? drag.i : item.i;
          const cx = xOf(u);
          const cy = yOf(i);
          const r = radiusOf(item.estimate);
          const color = SERIES_VAR[seriesOf(item)];
          const isSelected = selectedId === item.issue_id;
          return (
            <g
              key={item.issue_id}
              data-testid={`bubble-${item.number}`}
              className="cursor-grab"
              onPointerDown={onBubbleDown(item)}
              onPointerMove={onBubbleMove}
              onPointerUp={onBubbleUp(item)}
              onPointerEnter={() => onHover(item, cx, cy)}
              onPointerLeave={() => onHover(null, 0, 0)}
            >
              {item.pinned ? (
                <circle
                  data-testid={`pin-ring-${item.number}`}
                  cx={cx}
                  cy={cy}
                  r={r + 5}
                  fill="none"
                  stroke="var(--pin-ring)"
                  strokeDasharray="4 3"
                />
              ) : null}
              {isSelected ? (
                <circle cx={cx} cy={cy} r={r + 9} fill="none" stroke="var(--color-primary)" strokeWidth="1.5" />
              ) : null}
              <circle
                cx={cx}
                cy={cy}
                r={r}
                fill={color}
                stroke="var(--color-surface)"
                strokeWidth="2"
              />
              <text
                x={cx}
                y={cy + 3.5}
                textAnchor="middle"
                fontSize="10"
                fontWeight="600"
                fill="var(--color-text)"
                stroke="var(--color-surface)"
                strokeWidth="2.5"
                paintOrder="stroke"
                style={{ pointerEvents: "none" }}
              >
                #{item.number}
              </text>
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
        <span className="text-(--color-text-muted)">size = effort · dashed ring = pinned</span>
      </div>
    </div>
  );
}
