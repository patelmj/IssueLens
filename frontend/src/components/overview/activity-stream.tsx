"use client";

import { relativeTime } from "../../lib/time";
import type { OverviewEvent } from "./types";

const KIND_META: Record<
  OverviewEvent["kind"],
  { icon: string; color: string }
> = {
  opened: { icon: "＋", color: "var(--chart-opened)" },
  closed: { icon: "✓", color: "var(--chart-closed)" },
  synced: { icon: "↻", color: "var(--color-text-muted)" },
};

export function ActivityStream({ events }: { events: OverviewEvent[] }) {
  return (
    <div
      data-testid="activity-stream"
      className="rounded-[14px] border border-(--color-border) bg-(--color-surface) px-4 py-3 shadow-(--shadow-card)"
    >
      <div className="pb-2 text-[10px] font-semibold tracking-[0.08em] text-(--color-text-muted) uppercase">
        Activity
      </div>
      {events.length === 0 ? (
        <div className="py-4 text-center text-(--color-text-muted)">
          No recent activity
        </div>
      ) : (
        <ul className="flex flex-col gap-2">
          {events.map((event, idx) => {
            const meta = KIND_META[event.kind];
            return (
              <li key={idx} data-testid="event-row" className="flex items-center gap-2.5">
                <span
                  aria-hidden="true"
                  className="w-4 shrink-0 text-center font-semibold"
                  style={{ color: meta.color }}
                >
                  {meta.icon}
                </span>
                <span className="min-w-0 grow truncate">{event.text}</span>
                <span className="shrink-0 text-(--color-text-muted)">
                  {relativeTime(event.at)}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
