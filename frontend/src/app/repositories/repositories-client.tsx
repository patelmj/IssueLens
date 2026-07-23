"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { getJson, sendJson } from "../../lib/api";
import { relativeTime } from "../../lib/time";

type Repo = {
  id: number;
  full_name: string;
  private: boolean;
  open_issues_count: number;
  last_synced_at: string | null;
  sync_status: "idle" | "syncing" | "error";
  sync_error: string | null;
  visible: boolean;
};

const STATUS_DOT: Record<Repo["sync_status"], string> = {
  idle: "bg-(--color-text-muted)",
  syncing: "bg-(--color-primary)",
  error: "bg-(--color-danger)",
};

const card =
  "rounded-[14px] border border-(--color-border) bg-(--color-surface) shadow-(--shadow-card)";
const btn =
  "rounded-lg border border-(--color-border) bg-(--color-surface) px-2.5 py-1.5 text-(--color-primary) transition-all duration-150 hover:bg-(--accent-tint) disabled:text-(--color-text-muted) disabled:hover:bg-(--color-surface)";

const ALL_REPOS_KEY = ["repositories", "all"] as const;

export function RepositoriesClient() {
  const queryClient = useQueryClient();
  const [visibilityError, setVisibilityError] = useState<string | null>(null);
  const { data: repos, error, isPending } = useQuery({
    queryKey: ALL_REPOS_KEY,
    queryFn: () =>
      getJson<Repo[]>("/api/backend/repositories?include_hidden=true"),
    refetchInterval: (query) =>
      query.state.data?.some((r) => r.sync_status === "syncing") ? 3000 : false,
  });
  const refresh = useMutation({
    mutationFn: () =>
      getJson<Repo[]>("/api/backend/repositories/refresh", { method: "POST" }),
    onSuccess: (data) => {
      queryClient.setQueryData(ALL_REPOS_KEY, data);
      queryClient.invalidateQueries({ queryKey: ["repositories"], exact: true });
    },
  });
  const sync = useMutation({
    mutationFn: (id: number) =>
      getJson<{ queued: boolean }>(`/api/backend/repositories/${id}/sync`, {
        method: "POST",
      }),
    onSuccess: (_data, id) => {
      queryClient.setQueryData<Repo[]>(ALL_REPOS_KEY, (old) =>
        old?.map((r) => (r.id === id ? { ...r, sync_status: "syncing" } : r)),
      );
    },
  });
  const visibility = useMutation({
    mutationFn: ({ id, visible }: { id: number; visible: boolean }) =>
      sendJson<Repo>(`/api/backend/repositories/${id}`, "PATCH", { visible }),
    onMutate: () => setVisibilityError(null),
    onSuccess: (updated) => {
      queryClient.setQueryData<Repo[]>(ALL_REPOS_KEY, (old) =>
        old?.map((r) => (r.id === updated.id ? updated : r)),
      );
      queryClient.invalidateQueries({ queryKey: ["repositories"], exact: true });
      queryClient.invalidateQueries({ queryKey: ["overview-stats"] });
    },
    onError: (err) => setVisibilityError(err.message),
  });

  return (
    <div className="flex flex-col gap-4" data-testid="repositories-content">
      <div className="flex items-baseline gap-3">
        <h1 className="text-lg font-semibold tracking-[-0.01em]">Repositories</h1>
        <span className="text-(--color-text-muted)">Connected sources</span>
        <div className="grow" />
        <button
          type="button"
          className={btn}
          onClick={() => refresh.mutate()}
          disabled={refresh.isPending}
        >
          {refresh.isPending ? "Refreshing…" : "Refresh from GitHub"}
        </button>
      </div>

      {refresh.error ? (
        <div className={`${card} px-4 py-3 text-(--color-danger)`}>
          {refresh.error.message}
        </div>
      ) : null}
      {visibilityError ? (
        <div className={`${card} px-4 py-3 text-(--color-danger)`} data-testid="visibility-error">
          {visibilityError}
        </div>
      ) : null}

      {isPending ? (
        <div className={`${card} px-6 py-16 text-center text-(--color-text-muted)`}>
          Loading repositories…
        </div>
      ) : error ? (
        <div className={`${card} px-6 py-16 text-center`}>
          <div className="text-sm font-medium">Backend unavailable</div>
          <div className="pt-1.5 text-(--color-text-muted)">{error.message}</div>
        </div>
      ) : !repos || repos.length === 0 ? (
        <div className={`${card} flex flex-col items-center gap-1.5 px-6 py-16 text-center`}>
          <div className="text-sm font-medium">Connect GitHub</div>
          <div className="max-w-md text-(--color-text-muted)">
            Install your IssueLens GitHub App on the repositories you want to
            sync (see the README&apos;s &ldquo;GitHub App setup&rdquo;), then
            refresh. Repositories the App can reach will appear here.
          </div>
          <a
            className="pt-2 text-(--color-primary) hover:underline"
            href="https://github.com/settings/apps"
            target="_blank"
            rel="noreferrer"
          >
            Open GitHub App settings ↗
          </a>
        </div>
      ) : (
        <ul className="flex flex-col gap-2">
          {repos.map((repo) => (
            <li
              key={repo.id}
              data-testid={`repo-card-${repo.id}`}
              className={`${card} flex items-center gap-3 px-4 py-3`}
            >
              <span
                className={`inline-block h-2 w-2 rounded-full ${STATUS_DOT[repo.sync_status]}`}
                title={`Sync status: ${repo.sync_status}`}
              />
              <span
                className={`font-medium ${repo.visible ? "" : "text-(--color-text-muted)"}`}
              >
                {repo.full_name}
              </span>
              {repo.private ? (
                <span className="rounded-full border border-(--color-border) px-1.5 text-[10px] text-(--color-text-muted)">
                  private
                </span>
              ) : null}
              {!repo.visible ? (
                <span
                  data-testid={`hidden-pill-${repo.id}`}
                  className="rounded-full border border-(--color-border) px-1.5 text-[10px] text-(--color-text-muted)"
                >
                  hidden
                </span>
              ) : null}
              <span className="text-(--color-text-muted)">
                {repo.open_issues_count} open issues
              </span>
              <div className="grow" />
              {repo.sync_status === "error" && repo.sync_error ? (
                <span className="max-w-xs truncate text-(--color-danger)" title={repo.sync_error}>
                  {repo.sync_error}
                </span>
              ) : null}
              <span className="text-(--color-text-muted)">
                synced {relativeTime(repo.last_synced_at)}
              </span>
              <button
                type="button"
                data-testid={`visibility-toggle-${repo.id}`}
                aria-pressed={repo.visible}
                title={
                  repo.visible
                    ? "Hide this repository from selects and aggregate views (it keeps syncing)"
                    : "Show this repository everywhere again"
                }
                className={btn}
                onClick={() =>
                  visibility.mutate({ id: repo.id, visible: !repo.visible })
                }
                disabled={visibility.isPending}
              >
                {repo.visible ? "Hide" : "Show"}
              </button>
              <button
                type="button"
                className={btn}
                onClick={() => sync.mutate(repo.id)}
                disabled={repo.sync_status === "syncing"}
              >
                {repo.sync_status === "syncing" ? "Syncing…" : "Sync"}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
