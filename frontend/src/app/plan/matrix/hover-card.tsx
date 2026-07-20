"use client";

import type { PlottedItem } from "./matrix-types";
import { VIEW_H, VIEW_W } from "./matrix-chart";

export function MatrixHoverCard({
  item,
  cx,
  cy,
}: {
  item: PlottedItem;
  cx: number;
  cy: number;
}) {
  const left = `${Math.min(78, (cx / VIEW_W) * 100)}%`;
  const top = `${Math.min(70, (cy / VIEW_H) * 100)}%`;
  return (
    <div
      data-testid="hover-card"
      className="pointer-events-none absolute z-10 w-72 rounded-lg border border-(--color-border) bg-(--color-surface) p-3 shadow-(--shadow-card)"
      style={{ left, top }}
    >
      <div className="flex items-baseline gap-2">
        <span className="text-(--color-text-muted)">#{item.number}</span>
        <span className="min-w-0 truncate font-medium">{item.title}</span>
      </div>
      <div className="flex gap-3 pt-1 text-(--color-text-muted)">
        <span>{item.issue_type ?? "unclassified"}</span>
        {item.readiness_score != null ? <span>readiness {item.readiness_score}%</span> : null}
        <span className="tabular-nums">
          U {Math.round(item.u)} / I {Math.round(item.i)}
        </span>
        {item.pinned ? <span>pinned</span> : null}
      </div>
      {item.factors.length > 0 ? (
        <ul className="flex flex-col gap-0.5 pt-2" data-testid="hover-factors">
          {item.factors.map((factor, index) => (
            <li key={index} className="flex items-start gap-1.5">
              <span
                className={
                  factor.sign === "+" ? "text-(--pm-feature)" : "text-(--color-danger)"
                }
              >
                {factor.sign}
              </span>
              <span className="min-w-0 grow">{factor.text}</span>
              {factor.source === "llm" ? (
                <span className="rounded-full border border-(--color-border) px-1 text-[9px] text-(--color-text-muted)">
                  AI
                </span>
              ) : null}
            </li>
          ))}
        </ul>
      ) : (
        <div className="pt-2 text-(--color-text-muted)">Awaiting scores.</div>
      )}
    </div>
  );
}
