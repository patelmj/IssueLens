"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent,
} from "react";
import { iAt, PLOT, radiusOf, resolveCollisions, uAt, VIEW_H, VIEW_W, xOf, yOf } from "./matrix-layout";
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
  pointerId: number;
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
  const layoutInput = useMemo(() => {
    if (!drag?.moved) return plotted;
    return plotted.map((item) =>
      item.issue_id === drag.issueId
        ? { ...item, u: drag.u, i: drag.i, pinned: true }
        : item,
    );
  }, [plotted, drag]);
  const nudges = useMemo(() => resolveCollisions(layoutInput), [layoutInput]);
  const popRank = useMemo(() => {
    const order = [...plotted].sort((a, b) => b.u + b.i - (a.u + a.i));
    return new Map(order.map((item, index) => [item.issue_id, index]));
  }, [plotted]);
  const popStep = Math.min(70, 1400 / Math.max(plotted.length - 1, 1));

  const dragRef = useRef<DragState | null>(null);
  const onPinRef = useRef(onPin);
  const onSelectRef = useRef(onSelect);
  const selectedIdRef = useRef(selectedId);
  useEffect(() => {
    dragRef.current = drag;
    onPinRef.current = onPin;
    onSelectRef.current = onSelect;
    selectedIdRef.current = selectedId;
  });

  const clientToChart = useCallback(
    (point: { clientX: number; clientY: number }): { u: number; i: number } | null => {
      const svg = svgRef.current;
      if (!svg) return null;
      const rect = svg.getBoundingClientRect();
      const x = ((point.clientX - rect.left) / rect.width) * VIEW_W;
      const y = ((point.clientY - rect.top) / rect.height) * VIEW_H;
      return { u: uAt(x), i: iAt(y) };
    },
    [],
  );

  const onBubbleDown = (item: PlottedItem) => (e: PointerEvent<SVGGElement>) => {
    try {
      (e.currentTarget as Element & { setPointerCapture(id: number): void }).setPointerCapture(
        e.pointerId,
      );
    } catch {
      // best-effort: the window listeners below complete the gesture either way
    }
    setDrag({
      issueId: item.issue_id,
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      moved: false,
      u: item.u,
      i: item.i,
    });
  };

  // The gesture must survive losing pointer capture (touch cancels, SVG capture
  // quirks, fast flicks that outrun the one-render-behind bubble), so move/up/
  // cancel are tracked on window for the duration of a drag rather than on the
  // bubble element.
  const dragging = drag !== null;
  useEffect(() => {
    if (!dragging) return;

    const endDrag = () => setDrag(null);

    const onWindowMove = (e: globalThis.PointerEvent) => {
      const current = dragRef.current;
      if (!current || e.pointerId !== current.pointerId) return;
      const point = clientToChart(e);
      if (!point) return;
      const moved =
        current.moved ||
        Math.hypot(e.clientX - current.startX, e.clientY - current.startY) > DRAG_THRESHOLD_PX;
      setDrag({ ...current, moved, u: point.u, i: point.i });
    };

    const onWindowUp = (e: globalThis.PointerEvent) => {
      const current = dragRef.current;
      if (!current || e.pointerId !== current.pointerId) return;
      if (current.moved) {
        const point = clientToChart(e) ?? { u: current.u, i: current.i };
        onPinRef.current(
          current.issueId,
          Math.round(point.u * 10) / 10,
          Math.round(point.i * 10) / 10,
        );
      } else {
        const selected = selectedIdRef.current;
        onSelectRef.current(selected === current.issueId ? null : current.issueId);
      }
      endDrag();
    };

    const onWindowCancel = (e: globalThis.PointerEvent) => {
      const current = dragRef.current;
      if (!current || e.pointerId !== current.pointerId) return;
      endDrag();
    };

    window.addEventListener("pointermove", onWindowMove);
    window.addEventListener("pointerup", onWindowUp);
    window.addEventListener("pointercancel", onWindowCancel);
    window.addEventListener("blur", endDrag);
    return () => {
      window.removeEventListener("pointermove", onWindowMove);
      window.removeEventListener("pointerup", onWindowUp);
      window.removeEventListener("pointercancel", onWindowCancel);
      window.removeEventListener("blur", endDrag);
    };
  }, [dragging, clientToChart]);

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
              className={`matrix-bubble cursor-grab${dragging ? " matrix-bubble-dragging" : ""}`}
              style={{
                transform: `translate(${cx}px, ${cy}px)`,
                transformOrigin: `${cx}px ${cy}px`,
                "--pop-delay": `${Math.round((popRank.get(item.issue_id) ?? 0) * popStep)}ms`,
              } as CSSProperties}
              role="button"
              tabIndex={0}
              aria-label={`Issue #${item.number}: ${item.title}`}
              aria-pressed={isSelected}
              onPointerDown={onBubbleDown(item)}
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
                  cx={0}
                  cy={0}
                  r={r + 1}
                  fill="none"
                  stroke="var(--color-primary)"
                  strokeWidth={5}
                  opacity={0.35}
                  filter="url(#select-glow)"
                />
              ) : null}
              <circle
                cx={0}
                cy={0}
                r={r}
                fill={color}
                fillOpacity={0.85}
                stroke={color}
                strokeWidth={1.5}
              />
              <text
                x={0}
                y={3.5}
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
                  transform={`translate(${r * 0.72} ${-r * 0.72})`}
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
