"use client";

import { useQuery } from "@tanstack/react-query";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { getJson } from "../../lib/api";
import { InfoTip } from "./info-tip";
import { card, type CompletedAnalytics } from "./shared";
import { VelocityChart } from "./velocity-chart";
import { CycleHistogram } from "./cycle-histogram";
import { CompletionHeatmap } from "./completion-heatmap";

const WINDOWS = ["30d", "90d", "1y", "all"] as const;

type Repo = { id: number; full_name: string };

function Kpi({
  value, label, metric, testId,
}: { value: string; label: string; metric: Parameters<typeof InfoTip>[0]["metric"]; testId: string }) {
  return (
    <div className={card} data-testid={testId}>
      <div className="text-lg font-semibold tracking-tight">{value}</div>
      <div className="flex items-center gap-1.5 text-[11px] text-(--color-text-muted)">
        {label} <InfoTip metric={metric} />
      </div>
    </div>
  );
}

export function AnalyzeClient() {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const window = (WINDOWS as readonly string[]).includes(params.get("window") ?? "")
    ? (params.get("window") as (typeof WINDOWS)[number])
    : "90d";
  const repoId = params.get("repo_id");

  const setParam = (key: string, value: string | null) => {
    const next = new URLSearchParams(params.toString());
    if (value === null) next.delete(key);
    else next.set(key, value);
    router.replace(`${pathname}?${next.toString()}`);
  };

  const { data: repos } = useQuery({
    queryKey: ["repositories"],
    queryFn: () => getJson<Repo[]>("/api/backend/repositories"),
  });

  const query = new URLSearchParams({ window });
  if (repoId) query.set("repo_id", repoId);
  const { data, isPending, error } = useQuery({
    queryKey: ["completed-analytics", window, repoId],
    queryFn: () =>
      getJson<CompletedAnalytics>(`/api/backend/analytics/completed?${query.toString()}`),
  });

  if (isPending)
    return <div className="text-(--color-text-muted)">Loading analytics…</div>;
  if (error || !data)
    return <div className="text-(--color-text-muted)">Could not load analytics.</div>;

  const t = data.totals;
  const empty = t.completed === 0;

  return (
    <div className="flex flex-col gap-4" data-testid="analyze-page">
      <div className="flex items-baseline gap-3">
        <h1 className="text-lg font-semibold tracking-[-0.01em]">Analyze</h1>
        <span className="text-(--color-text-muted)">
          What you&apos;ve completed, and where it landed
        </span>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <select
          aria-label="Repository filter"
          className="rounded-lg border border-(--color-border) bg-(--color-surface) px-2 py-1 text-[12px]"
          value={repoId ?? ""}
          onChange={(e) => setParam("repo_id", e.target.value || null)}
          data-testid="repo-filter"
        >
          <option value="">All repos</option>
          {(repos ?? []).map((r) => (
            <option key={r.id} value={r.id}>
              {r.full_name}
            </option>
          ))}
        </select>
        <div
          className="flex rounded-[9px] border border-(--color-border) bg-(--color-surface) p-0.5"
          data-testid="window-filter"
        >
          {WINDOWS.map((w) => (
            <button
              key={w}
              type="button"
              className={`rounded-[7px] px-2.5 py-0.5 text-[12px] transition-all duration-150 ${
                w === window
                  ? "bg-(--accent-tint) font-semibold text-(--color-primary)"
                  : "text-(--color-text-muted)"
              }`}
              onClick={() => setParam("window", w)}
            >
              {w === "all" ? "All" : w}
            </button>
          ))}
        </div>
      </div>

      {empty ? (
        <div className={`${card} text-(--color-text-muted)`} data-testid="analyze-empty">
          No completions in this window. Widen the range or close some issues — then come brag here.
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4 min-[900px]:grid-cols-[1.8fr_1fr]">
          <div className="flex flex-col gap-4">
            <div className="grid grid-cols-3 gap-3">
              <Kpi value={String(t.completed)} label={`completed · ${window}`} metric="completed" testId="kpi-completed" />
              <Kpi value={t.median_cycle_days === null ? "—" : `${t.median_cycle_days}d`} label="median cycle" metric="median_cycle" testId="kpi-cycle" />
              <Kpi value={t.do_first_pct === null ? "—" : `${t.do_first_pct}%`} label="closed in Do First" metric="do_first" testId="kpi-dofirst" />
            </div>
            <VelocityChart weekly={data.weekly} />
            <div className="grid grid-cols-1 gap-4 min-[720px]:grid-cols-2">
              <CompletionHeatmap cells={data.heatmap} />
              <CycleHistogram buckets={data.cycle_buckets} totals={t} />
            </div>
          </div>
          <div className="flex flex-col gap-4">
            {/* Task 7 mounts <StreakCard streak={data.streak} />, <RepoBars repos={data.repos} />, <RecentFeed recent={data.recent} /> */}
          </div>
        </div>
      )}
    </div>
  );
}
