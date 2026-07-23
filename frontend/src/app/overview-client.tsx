"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useEffect, useState } from "react";
import { getJson } from "../lib/api";
import { ActivityChart } from "../components/activity-chart";
import { IssueDetailPanel } from "../components/issue-detail-panel";
import { DoFirstSpotlight } from "../components/overview/do-first-spotlight";
import { MatrixMinimap } from "../components/overview/matrix-minimap";
import { TriageTeaserCard } from "../components/overview/triage-teaser";
import { SyncHealthCard } from "../components/overview/sync-health";
import { RightRail } from "../components/right-rail";
import { Sparkline } from "../components/sparkline";
import type { OverviewStats } from "../components/overview/types";

const card =
  "rounded-[14px] border border-(--color-border) bg-(--color-surface) shadow-(--shadow-card)";

function DeltaBadge({ delta, goodWhenDown }: { delta: number; goodWhenDown: boolean }) {
  if (delta === 0) return null;
  const rising = delta > 0;
  const good = goodWhenDown ? !rising : rising;
  return (
    <span
      className="text-[11px] font-medium"
      style={{ color: good ? "var(--chart-closed)" : "var(--color-danger)" }}
    >
      {rising ? "▲" : "▼"} {Math.abs(delta)}
    </span>
  );
}

function TrendTile({
  label, value, delta, goodWhenDown, spark, sparkStroke, testId,
}: {
  label: string;
  value: string;
  delta?: number;
  goodWhenDown?: boolean;
  spark?: number[];
  sparkStroke?: string;
  testId: string;
}) {
  return (
    <div data-testid={testId} className={`${card} flex flex-col gap-1 px-4 py-3`}>
      <div className="text-[10px] font-semibold tracking-[0.08em] text-(--color-text-muted) uppercase">
        {label}
      </div>
      <div className="flex items-baseline gap-2">
        <span className="text-2xl font-semibold tracking-[-0.01em]">{value}</span>
        {delta !== undefined ? (
          <DeltaBadge delta={delta} goodWhenDown={goodWhenDown ?? false} />
        ) : null}
      </div>
      {spark ? <Sparkline points={spark} stroke={sparkStroke ?? "var(--color-primary)"} /> : null}
    </div>
  );
}

export function OverviewClient() {
  const { data, error, isPending } = useQuery({
    queryKey: ["overview-stats"],
    queryFn: () => getJson<OverviewStats>("/api/backend/stats/overview"),
    refetchInterval: 30_000,
  });
  const trend = data?.open_trend ?? [];
  const weekDelta = trend.length >= 8 ? trend[trend.length - 1] - trend[trend.length - 8] : 0;

  const [detailIssueId, setDetailIssueId] = useState<number | null>(null);

  useEffect(() => {
    if (detailIssueId == null) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setDetailIssueId(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [detailIssueId]);

  return (
    <div className="flex flex-col gap-4" data-testid="overview-content">
      <div className="flex items-baseline gap-3">
        <h1 className="text-lg font-semibold tracking-[-0.01em]">Overview</h1>
        <span className="text-(--color-text-muted)">Your issue landscape at a glance</span>
      </div>

      {isPending ? (
        <div className={`${card} px-6 py-16 text-center text-(--color-text-muted)`}>
          Loading overview…
        </div>
      ) : error ? (
        <div className={`${card} px-6 py-16 text-center`}>
          <div className="text-sm font-medium">Backend unavailable</div>
          <div className="pt-1.5 text-(--color-text-muted)">{error.message}</div>
        </div>
      ) : !data || data.connected_repos === 0 ? (
        <div className={`${card} flex flex-col items-center gap-1.5 px-6 py-16 text-center`}>
          <div className="text-sm font-medium">
            Connect GitHub to see your issue landscape
          </div>
          <div className="max-w-md text-(--color-text-muted)">
            Install the IssueLens GitHub App and sync a repository — stats,
            activity, and the issues table light up from your real data.
          </div>
          <Link
            className="pt-2 text-(--color-primary) hover:underline"
            href="/repositories"
          >
            Go to Repositories →
          </Link>
        </div>
      ) : (
        <>
          <div className="grid grid-cols-3 gap-4">
            <div className="col-span-2">
              <DoFirstSpotlight items={data.do_first} onOpen={setDetailIssueId} />
            </div>
            <div className="flex flex-col gap-4" data-testid="overview-side-stack">
              <MatrixMinimap points={data.minimap} />
              <TriageTeaserCard teaser={data.triage} />
              <SyncHealthCard sync={data.sync} />
            </div>
          </div>
          <div data-testid="health-band" className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <TrendTile
              testId="tile-open"
              label="Open issues"
              value={String(data.open_issues)}
              delta={weekDelta}
              goodWhenDown
              spark={trend}
              sparkStroke="var(--color-primary)"
            />
            <TrendTile
              testId="tile-closed-week"
              label="Closed this week"
              value={String(data.closed_week.count)}
              delta={data.closed_week.delta}
              spark={data.activity.map((day) => day.closed)}
              sparkStroke="var(--chart-closed)"
            />
            <TrendTile
              testId="tile-median-age"
              label="Median open age"
              value={data.median_age_days != null ? `${data.median_age_days}d` : "—"}
            />
            <TrendTile
              testId="tile-stale"
              label="Stale 30d+"
              value={String(data.stale_count)}
            />
          </div>
          <div className={`${card} px-4 py-3`}>
            <div className="flex items-baseline justify-between pb-1">
              <span className="text-sm font-medium">Opened vs closed</span>
              <span className="text-(--color-text-muted)">last 30 days</span>
            </div>
            <ActivityChart data={data.activity} />
          </div>
          <div className={`${card} px-4 py-3`}>
            <div className="flex items-baseline justify-between pb-2">
              <span className="text-sm font-medium">Repositories</span>
              <Link
                href="/repositories"
                className="text-(--color-primary) hover:underline"
              >
                View all →
              </Link>
            </div>
            <ul className="flex flex-col gap-1.5">
              {data.top_repos.map((repo) => (
                <li key={repo.id} className="flex items-center gap-3">
                  <Link
                    href={`/plan?repo_id=${repo.id}`}
                    className="font-medium hover:text-(--color-primary)"
                  >
                    {repo.full_name}
                  </Link>
                  <span className="text-(--color-text-muted)">
                    {repo.open_issues_count} open
                  </span>
                </li>
              ))}
            </ul>
          </div>
          {detailIssueId != null ? (
            <RightRail>
              <div className="rail-slide-in">
                <IssueDetailPanel issueId={detailIssueId} onBack={() => setDetailIssueId(null)} />
              </div>
            </RightRail>
          ) : null}
        </>
      )}
    </div>
  );
}
