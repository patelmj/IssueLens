"use client";

import { useState } from "react";
import { card, type CompletedAnalytics } from "./shared";
import { InfoTip, ValueTip, type TipState } from "./info-tip";

const BINS = 20;
const CELL = 16;
const GAP = 2;
const SIZE = BINS * CELL;

function rampToken(count: number, max: number): string {
  const step = Math.min(5, Math.max(1, Math.ceil((count / max) * 5)));
  return `var(--viz-seq-${step})`;
}

export function CompletionHeatmap({ cells }: { cells: CompletedAnalytics["heatmap"] }) {
  const [tip, setTip] = useState<TipState>(null);
  const max = Math.max(1, ...cells.map((c) => c.count));
  const byBin = new Map(cells.map((c) => [`${c.u_bin}-${c.i_bin}`, c]));

  return (
    <div className={`${card} relative`} data-testid="completion-heatmap">
      <div className="mb-2 flex items-center gap-1.5 text-[12px] font-semibold">
        Completion heatmap <InfoTip metric="heatmap" />
      </div>
      <div className="relative">
        <span className="absolute left-1 top-0 z-10 text-[8px] font-semibold tracking-wider text-(--color-text-muted)">SCHEDULE</span>
        <span className="absolute right-1 top-0 z-10 text-[8px] font-semibold tracking-wider text-(--color-text-muted)">DO FIRST</span>
        <span className="absolute bottom-4 left-1 z-10 text-[8px] font-semibold tracking-wider text-(--color-text-muted)">RECONSIDER</span>
        <span className="absolute bottom-4 right-1 z-10 text-[8px] font-semibold tracking-wider text-(--color-text-muted)">DELEGATE</span>
        <svg viewBox={`0 0 ${SIZE} ${SIZE}`} className="w-full" role="img" aria-label="Completed issues by urgency and importance">
          {Array.from({ length: BINS }, (_, u) =>
            Array.from({ length: BINS }, (_, i) => {
              const cell = byBin.get(`${u}-${i}`);
              const y = (BINS - 1 - i) * CELL; // importance up
              return (
                <rect
                  key={`${u}-${i}`}
                  x={u * CELL}
                  y={y}
                  width={CELL - GAP}
                  height={CELL - GAP}
                  rx={2}
                  data-testid={cell ? `heat-cell-${u}-${i}` : undefined}
                  fill={cell ? rampToken(cell.count, max) : "var(--color-bg)"}
                  stroke={cell ? "none" : "var(--color-border)"}
                  strokeWidth={cell ? 0 : 0.5}
                  onMouseEnter={(e) => {
                    if (!cell) return;
                    const host = e.currentTarget.ownerSVGElement!.getBoundingClientRect();
                    const rect = e.currentTarget.getBoundingClientRect();
                    setTip({
                      x: rect.left - host.left + 12,
                      y: rect.top - host.top - 8,
                      lines: [
                        `urgency ${u * 5}–${u * 5 + 5} · importance ${i * 5}–${i * 5 + 5}`,
                        `${cell.count} completed — ${cell.sample_issues.map((n) => `#${n}`).join(", ")}${
                          cell.count > cell.sample_issues.length
                            ? ` +${cell.count - cell.sample_issues.length}`
                            : ""
                        }`,
                      ],
                    });
                  }}
                  onMouseLeave={() => setTip(null)}
                />
              );
            }),
          )}
        </svg>
        <div className="mt-0.5 text-[9px] text-(--color-text-muted)">urgency →</div>
      </div>
      <ValueTip tip={tip} />
    </div>
  );
}
