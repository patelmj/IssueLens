"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { getJson } from "../lib/api";
import { relativeTime } from "../lib/time";

export type ActivityDay = { date: string; opened: number; closed: number };

type TopRepo = { id: number; full_name: string; open_issues_count: number };

type OverviewStats = {
  connected_repos: number;
  open_issues: number;
  last_synced_at: string | null;
  top_repos: TopRepo[];
  activity: ActivityDay[];
};

const card =
  "rounded-[14px] border border-(--color-border) bg-(--color-surface) shadow-(--shadow-card)";

function StatTile({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className={`${card} flex flex-col gap-1 px-4 py-3`}>
      <div className="text-[10px] font-semibold tracking-[0.08em] text-(--color-text-muted) uppercase">
        {label}
      </div>
      <div className="text-2xl font-semibold tracking-[-0.01em]">{value}</div>
      {sub ? <div className="text-(--color-text-muted)">{sub}</div> : null}
    </div>
  );
}

export function OverviewClient() {
  const { data, error, isPending } = useQuery({
    queryKey: ["overview-stats"],
    queryFn: () => getJson<OverviewStats>("/api/backend/stats/overview"),
    refetchInterval: 30_000,
  });
  const top = data?.top_repos[0];

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
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <StatTile label="Connected repos" value={String(data.connected_repos)} />
            <StatTile label="Open issues" value={String(data.open_issues)} />
            <StatTile label="Last synced" value={relativeTime(data.last_synced_at)} />
            <StatTile
              label="Biggest repo"
              value={top ? top.full_name.split("/")[1] : "—"}
              sub={top ? `${top.open_issues_count} open issues` : undefined}
            />
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
        </>
      )}
    </div>
  );
}
