"use client";

import { card, type CompletedAnalytics } from "./shared";
import { InfoTip } from "./info-tip";

const TYPE_TOKEN: Record<string, string> = {
  bug: "var(--type-bug)",
  feature: "var(--type-feature)",
  debt: "var(--type-debt)",
  other: "var(--type-task)",
};

const QUADRANT_LABEL: Record<string, string> = {
  do_first: "Do First",
  schedule: "Schedule",
  delegate: "Delegate",
  reconsider: "Reconsider",
};

export function StreakCard({ streak }: { streak: CompletedAnalytics["streak"] }) {
  const max = Math.max(1, ...streak.weeks.map((w) => w.count));
  return (
    <div className={card} data-testid="streak-card">
      <div className="flex items-center gap-1.5 text-[12px] font-semibold">
        Streak <InfoTip metric="streak" />
      </div>
      <div className="mt-1 text-[15px] font-semibold">
        {streak.current} {streak.current === 1 ? "week" : "weeks"}
      </div>
      <div className="mt-1.5 flex gap-1">
        {streak.weeks.map((w) => (
          <span
            key={w.week_start}
            title={`${w.week_start}: ${w.count}`}
            className="h-2.5 w-2.5 rounded-[2px]"
            style={
              w.count === 0
                ? { background: "var(--color-bg)", border: "1px solid var(--color-border)" }
                : { background: w.count >= max ? "var(--viz-seq-5)" : "var(--viz-seq-2)" }
            }
          />
        ))}
      </div>
    </div>
  );
}

const TOP_REPOS = 3;

export function RepoBars({ repos }: { repos: CompletedAnalytics["repos"] }) {
  const top = repos.slice(0, TOP_REPOS);
  const rest = repos.slice(TOP_REPOS);
  const rows = [
    ...top.map((r) => ({ name: r.full_name.split("/").pop() ?? r.full_name, ...r })),
    ...(rest.length
      ? [{
          name: `Other (${rest.length})`,
          repository_id: -1,
          full_name: "",
          count: rest.reduce((n, r) => n + r.count, 0),
          pct: rest.reduce((n, r) => n + r.pct, 0),
        }]
      : []),
  ];
  return (
    <div className={card} data-testid="repo-bars">
      <div className="flex items-center gap-1.5 text-[12px] font-semibold">
        Where the work happens <InfoTip metric="repos" />
      </div>
      {rows.map((r) => (
        <div key={r.name} className="mt-2">
          <div className="flex justify-between text-[11px]">
            <span className="font-medium">{r.name}</span>
            <span className="text-(--color-text-muted)">
              {r.count} · {r.pct}%
            </span>
          </div>
          <div className="mt-0.5 h-1.5 overflow-hidden rounded-full bg-(--color-bg)">
            <div
              className="h-full rounded-full"
              style={{ width: `${r.pct}%`, background: "var(--viz-seq-3)" }}
            />
          </div>
        </div>
      ))}
    </div>
  );
}

export function RecentFeed({ recent }: { recent: CompletedAnalytics["recent"] }) {
  return (
    <div className={`${card} flex-1`} data-testid="recent-feed">
      <h3 className="text-[12px] font-semibold m-0">Recently completed</h3>
      {recent.map((r) => (
        <div
          key={`${r.repo}-${r.number}`}
          className="flex items-center gap-2 border-t border-(--color-border) py-1.5 text-[11px] first-of-type:border-t-0"
          data-testid={`feed-row-${r.number}`}
        >
          <span
            className="h-2 w-2 flex-none rounded-full"
            style={{ background: TYPE_TOKEN[r.type] ?? "var(--type-task)" }}
          />
          <span className="truncate">#{r.number} {r.title}</span>
          <span className="ml-auto whitespace-nowrap text-[10px] text-(--color-text-muted)">
            {r.quadrant ? `${QUADRANT_LABEL[r.quadrant]} · ` : ""}{r.cycle_days}d
          </span>
        </div>
      ))}
    </div>
  );
}
