"use client";

import { useQuery } from "@tanstack/react-query";
import { getJson } from "../lib/api";
import { ThemeToggle } from "./theme-toggle";

type OverviewStats = {
  connected_repos: number;
  open_issues: number;
};

export function Header() {
  const { data } = useQuery({
    queryKey: ["overview-stats"],
    queryFn: () => getJson<OverviewStats>("/api/backend/stats/overview"),
    refetchInterval: 30_000,
  });

  const chip = !data
    ? "—"
    : data.connected_repos === 0
      ? "No repository connected"
      : `${data.connected_repos} repos · ${data.open_issues} open issues`;

  return (
    <header className="flex items-center gap-3 border-b border-(--color-border) px-5 py-2.5">
      <div className="flex items-center gap-1.5 font-semibold">
        <span className="inline-block h-2.5 w-2.5 rounded-full bg-(--color-primary)" />
        IssueLens
      </div>
      <span
        data-testid="header-chip"
        className="rounded-lg border border-(--color-border) bg-(--color-surface) px-2 py-1 text-(--color-text-muted)"
      >
        {chip}
      </span>
      <div className="grow" />
      <button
        type="button"
        disabled
        title="Command palette — coming soon"
        className="rounded-lg border border-(--color-border) bg-(--color-surface) px-2.5 py-1.5 text-(--color-text-muted)"
      >
        ⌘K
      </button>
      <ThemeToggle />
    </header>
  );
}
