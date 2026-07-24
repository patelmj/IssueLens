"use client";

import { useState } from "react";

export const METRIC_HELP: Record<string, string> = {
  completed: "Closed, non-PR issues across your connected repos in the selected range.",
  median_cycle:
    "Days from GitHub creation to close, across issues closed in the selected range. Half your completions were faster than this.",
  do_first:
    "Share of prioritized completions that sat in the Do First quadrant (urgency ≥ 50 and importance ≥ 50, manual pins included) when closed.",
  streak: "Consecutive weeks, ending now, with at least one completion. A quiet current week doesn't break last week's run.",
  velocity: "Completions per week, colored by classified type. Question/docs/unclassified fold into Other.",
  heatmap:
    "Each closed issue plotted by its urgency and importance (manual pins win) in 5-point bins. Darker cells mean more completions landed there.",
  cycle: "Distribution of created→closed durations for the selected range.",
  repos: "Where the selected range's completions happened, by repository.",
};

export function InfoTip({ metric }: { metric: keyof typeof METRIC_HELP }) {
  const [open, setOpen] = useState(false);
  return (
    <span className="relative inline-flex">
      <button
        type="button"
        aria-label={`What does ${metric} mean?`}
        className="inline-flex h-3.5 w-3.5 items-center justify-center rounded-full border border-(--color-border) text-[9px] text-(--color-text-muted) transition-all duration-150 hover:border-(--color-primary) hover:text-(--color-primary)"
        onClick={() => setOpen((v) => !v)}
        onBlur={() => setOpen(false)}
        data-testid={`info-${metric}`}
      >
        i
      </button>
      {open ? (
        <span
          className="absolute left-0 top-full z-20 mt-1 w-56 rounded-lg border border-(--color-border) bg-(--color-surface) p-2 text-[11px] font-normal normal-case leading-snug text-(--color-text) shadow-lg"
          data-testid={`info-popover-${metric}`}
        >
          {METRIC_HELP[metric]}
        </span>
      ) : null}
    </span>
  );
}

export type TipState = { x: number; y: number; lines: string[] } | null;

export function ValueTip({ tip }: { tip: TipState }) {
  if (!tip) return null;
  return (
    <div
      className="pointer-events-none absolute z-20 min-w-36 rounded-lg border border-(--color-border) bg-(--color-surface) p-2 text-[11px] shadow-lg"
      style={{ left: tip.x, top: tip.y }}
      data-testid="value-tip"
    >
      {tip.lines.map((line, i) => (
        <div key={i} className={i === 0 ? "font-semibold" : "text-(--color-text-muted)"}>
          {line}
        </div>
      ))}
    </div>
  );
}
