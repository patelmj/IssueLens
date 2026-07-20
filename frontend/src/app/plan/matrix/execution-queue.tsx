"use client";

import { useEffect, useRef } from "react";
import {
  QUADRANT_LABEL,
  quadrantOf,
  SERIES_VAR,
  seriesOf,
  type PlottedItem,
  type Quadrant,
} from "./matrix-types";

const GROUP_ORDER: Quadrant[] = ["dofirst", "schedule", "delegate", "reconsider"];

export function ExecutionQueue({
  plotted,
  selectedId,
  onSelect,
}: {
  plotted: PlottedItem[];
  selectedId: number | null;
  onSelect: (id: number | null) => void;
}) {
  // rank signature per issue: "<quadrant>:<index>" — change triggers the flash
  const prevRanks = useRef<Map<number, string>>(new Map());
  const flashIds = useRef<Set<number>>(new Set());

  const groups = GROUP_ORDER.map((quadrant) => ({
    quadrant,
    items: plotted
      .filter((item) => quadrantOf(item) === quadrant)
      .sort((a, b) => b.u + b.i - (a.u + a.i)),
  }));

  const nextRanks = new Map<number, string>();
  for (const group of groups) {
    group.items.forEach((item, index) =>
      nextRanks.set(item.issue_id, `${group.quadrant}:${index}`),
    );
  }
  /* eslint-disable react-hooks/refs -- render-time diff of rank signature against the previous-render ref snapshot; brief-specified pattern for the flash class, not used to drive JSX output */
  flashIds.current = new Set(
    [...nextRanks].filter(([id, sig]) => {
      const prev = prevRanks.current.get(id);
      return prev !== undefined && prev !== sig;
    }).map(([id]) => id),
  );
  /* eslint-enable react-hooks/refs */

  useEffect(() => {
    prevRanks.current = nextRanks;
  });

  useEffect(() => {
    if (selectedId == null) return;
    document
      .querySelector(`[data-qrow-id="${selectedId}"]`)
      ?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [selectedId]);

  return (
    <div
      className="flex max-h-[calc(100vh-120px)] flex-col gap-3 overflow-y-auto rounded-[14px] border border-(--color-border) bg-(--color-surface) p-4 shadow-(--shadow-card)"
      data-testid="execution-queue"
    >
      <div className="text-[10px] font-semibold tracking-[0.08em] text-(--color-text-muted) uppercase">
        Execution queue
      </div>
      {
        // eslint-disable-next-line react-hooks/refs -- reads flashIds.current (computed above, same render pass) to toggle the flash class; brief-specified pattern
        groups.map(({ quadrant, items }) =>
        items.length === 0 ? null : (
          <div key={quadrant} data-testid={`qgroup-${quadrant}`}>
            <div className="pb-1 text-[10px] font-semibold tracking-[0.08em] text-(--color-text-muted) uppercase">
              {QUADRANT_LABEL[quadrant]}
            </div>
            <ul className="flex flex-col">
              {items.map((item, index) => (
                <li key={item.issue_id}>
                  <button
                    type="button"
                    data-qrow-id={item.issue_id}
                    data-testid={`qrow-${item.number}`}
                    onClick={() =>
                      onSelect(selectedId === item.issue_id ? null : item.issue_id)
                    }
                    className={`flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left transition-all duration-150 ${
                      flashIds.current.has(item.issue_id) ? "qrow-flash" : ""
                    } ${
                      selectedId === item.issue_id
                        ? "bg-(--accent-tint)"
                        : "hover:bg-(--accent-tint)"
                    }`}
                  >
                    <span className="w-4 text-right text-(--color-text-muted) tabular-nums">
                      {index + 1}
                    </span>
                    <span
                      className="inline-block h-2 w-2 shrink-0 rounded-full"
                      style={{ background: SERIES_VAR[seriesOf(item)] }}
                    />
                    <span className="text-(--color-text-muted)">#{item.number}</span>
                    <span className="min-w-0 grow truncate" title={item.title}>
                      {item.title}
                    </span>
                    <span className="text-(--color-text-muted) tabular-nums">
                      {Math.round(item.u + item.i)}
                    </span>
                    {item.pinned ? <span aria-label="pinned">📌</span> : null}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        ),
      )}
    </div>
  );
}
