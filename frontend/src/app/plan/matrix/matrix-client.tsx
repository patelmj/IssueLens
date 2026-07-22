"use client";

import {
  keepPreviousData,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useState } from "react";
import { getJson, sendJson } from "../../../lib/api";
import { RightRail } from "../../../components/right-rail";
import { PlanTabs } from "../plan-tabs";
import { ExecutionQueue } from "./execution-queue";
import { MatrixHoverCard } from "./hover-card";
import { MatrixChart } from "./matrix-chart";
import {
  toPlotted,
  type MatrixItem,
  type MatrixPayload,
  type PlottedItem,
} from "./matrix-types";
import { FilterChips } from "../../../components/filter-chips";
import { PinGlyph } from "./pin-glyph";
import { SaveViewButton } from "../../../components/save-view";
import {
  applyFilters,
  filtersToSearch,
  hasActiveFilters,
  parseFilters,
  type MatrixFilters,
} from "../../../lib/matrix-filters";

const card =
  "rounded-[14px] border border-(--color-border) bg-(--color-surface) shadow-(--shadow-card)";

type Repo = { id: number; full_name: string };

export function MatrixClient() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const queryClient = useQueryClient();

  const { data: repos, isPending: reposPending } = useQuery({
    queryKey: ["repositories"],
    queryFn: () => getJson<Repo[]>("/api/backend/repositories"),
  });

  const repoParam = searchParams.get("repo_id");
  const repoId = repoParam ? Number(repoParam) : (repos?.[0]?.id ?? null);
  const matrixKey = ["matrix", repoId] as const;

  const filters = parseFilters(searchParams);

  const navigateWith = useCallback(
    (nextRepoId: number | null, nextFilters: MatrixFilters) => {
      const search = filtersToSearch(nextRepoId, nextFilters);
      router.replace(search ? `/plan/matrix?${search}` : "/plan/matrix", {
        scroll: false,
      });
    },
    [router],
  );

  const { data, error, isPending } = useQuery({
    queryKey: matrixKey,
    queryFn: () => getJson<MatrixPayload>(`/api/backend/repositories/${repoId}/priority`),
    enabled: repoId != null,
    placeholderData: keepPreviousData,
  });

  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [hover, setHover] = useState<{ item: PlottedItem; cx: number; cy: number } | null>(null);
  const [mutationError, setMutationError] = useState<string | null>(null);
  const [confirmingReleaseAll, setConfirmingReleaseAll] = useState(false);

  const patchItem = useCallback(
    (issueId: number, patch: Partial<MatrixItem>) => {
      queryClient.setQueryData<MatrixPayload>(matrixKey, (old) =>
        old
          ? {
              ...old,
              items: old.items.map((item) =>
                item.issue_id === issueId ? { ...item, ...patch } : item,
              ),
            }
          : old,
      );
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [queryClient, repoId],
  );

  const pinMutation = useMutation({
    mutationFn: ({ issueId, urgency, importance }: {
      issueId: number; urgency: number; importance: number;
    }) =>
      sendJson<{ issue_id: number }>(`/api/backend/issues/${issueId}/pin`, "PUT", {
        urgency,
        importance,
      }),
    onMutate: async ({ issueId, urgency, importance }) => {
      await queryClient.cancelQueries({ queryKey: matrixKey });
      const previous = queryClient.getQueryData<MatrixPayload>(matrixKey);
      patchItem(issueId, {
        pinned: true,
        pinned_urgency: urgency,
        pinned_importance: importance,
      });
      setMutationError(null);
      return { previous };
    },
    onError: (err, _vars, context) => {
      if (context?.previous) queryClient.setQueryData(matrixKey, context.previous);
      setMutationError(err.message);
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: matrixKey }),
  });

  const releaseMutation = useMutation({
    mutationFn: (issueId: number) =>
      sendJson<undefined>(`/api/backend/issues/${issueId}/pin`, "DELETE"),
    onMutate: async (issueId) => {
      await queryClient.cancelQueries({ queryKey: matrixKey });
      const previous = queryClient.getQueryData<MatrixPayload>(matrixKey);
      patchItem(issueId, { pinned: false, pinned_urgency: null, pinned_importance: null });
      setMutationError(null);
      return { previous };
    },
    onError: (err, _vars, context) => {
      if (context?.previous) queryClient.setQueryData(matrixKey, context.previous);
      setMutationError(err.message);
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: matrixKey }),
  });

  const releaseAllMutation = useMutation({
    mutationFn: (issueIds: number[]) =>
      Promise.all(
        issueIds.map((issueId) =>
          sendJson<undefined>(`/api/backend/issues/${issueId}/pin`, "DELETE"),
        ),
      ),
    onMutate: async (issueIds) => {
      await queryClient.cancelQueries({ queryKey: matrixKey });
      const previous = queryClient.getQueryData<MatrixPayload>(matrixKey);
      for (const issueId of issueIds) {
        patchItem(issueId, { pinned: false, pinned_urgency: null, pinned_importance: null });
      }
      setMutationError(null);
      return { previous };
    },
    onError: (err, _vars, context) => {
      if (context?.previous) queryClient.setQueryData(matrixKey, context.previous);
      setMutationError(err.message);
    },
    onSettled: () => {
      setConfirmingReleaseAll(false);
      return queryClient.invalidateQueries({ queryKey: matrixKey });
    },
  });

  const items = data?.items ?? [];
  const pinnedItems = items.filter((item) => item.pinned);
  const filtersActive = hasActiveFilters(filters);
  const filtered = applyFilters(items, filters);
  const plotted = toPlotted(filtered);
  const allPlottedCount = toPlotted(items).length;
  const selected = filtered.find((item) => item.issue_id === selectedId) ?? null;

  return (
    <div className="flex flex-col gap-4" data-testid="matrix-content">
      <div className="flex items-baseline gap-3">
        <h1 className="text-lg font-semibold tracking-[-0.01em]">Plan</h1>
        <span className="text-(--color-text-muted)">
          Urgency × importance — drag a bubble to pin it
        </span>
        <div className="grow" />
        <PlanTabs />
      </div>

      <div className="flex items-center gap-2">
        <select
          aria-label="Repository"
          className="rounded-lg border border-(--color-border) bg-(--color-surface) px-2.5 py-1.5"
          value={repoId ?? ""}
          onChange={(e) =>
            navigateWith(e.target.value ? Number(e.target.value) : null, filters)
          }
        >
          {(repos ?? []).map((repo) => (
            <option key={repo.id} value={repo.id}>
              {repo.full_name}
            </option>
          ))}
        </select>
        <FilterChips
          filters={filters}
          onChange={(next) => navigateWith(repoId, next)}
        />
        {filtersActive && data ? (
          <span className="text-(--color-text-muted)" data-testid="filter-count">
            {plotted.length} of {allPlottedCount} shown
          </span>
        ) : null}
        {pinnedItems.length > 0 ? (
          <span
            data-testid="pinned-chip"
            className="flex items-center gap-1.5 rounded-full border border-(--color-border) px-2 py-0.5 text-(--color-text-muted)"
          >
            <PinGlyph className="h-3 w-3 shrink-0" />
            {confirmingReleaseAll ? (
              <>
                <span>Release all {pinnedItems.length}?</span>
                <button
                  type="button"
                  data-testid="release-all-confirm"
                  className="text-(--color-primary) transition-all duration-150 hover:underline"
                  onClick={() =>
                    releaseAllMutation.mutate(pinnedItems.map((item) => item.issue_id))
                  }
                >
                  Confirm
                </button>
                <button
                  type="button"
                  aria-label="Cancel release all"
                  className="transition-all duration-150 hover:text-(--color-text)"
                  onClick={() => setConfirmingReleaseAll(false)}
                >
                  ✕
                </button>
              </>
            ) : (
              <button
                type="button"
                data-testid="release-all"
                className="transition-all duration-150 hover:text-(--color-text)"
                onClick={() => setConfirmingReleaseAll(true)}
              >
                {pinnedItems.length} pinned
              </button>
            )}
          </span>
        ) : null}
        <SaveViewButton
          viewKind="matrix"
          repositoryId={repoId}
          canSave={repoId != null && hasActiveFilters(filters)}
          filters={{ types: filters.types, readiness: filters.readiness }}
        />
        {data && data.unscored > 0 ? (
          <span
            className="rounded-full border border-(--color-border) px-2 py-0.5 text-[10px] text-(--color-text-muted)"
            data-testid="unscored-chip"
          >
            {data.unscored} issue{data.unscored === 1 ? "" : "s"} awaiting scores
          </span>
        ) : null}
        {mutationError ? (
          <span className="text-(--color-danger)" data-testid="pin-error">
            {mutationError}
          </span>
        ) : null}
      </div>

      {reposPending || (repoId != null && isPending) ? (
        <div className={`${card} px-6 py-16 text-center text-(--color-text-muted)`}>
          Loading matrix…
        </div>
      ) : error ? (
        <div className={`${card} px-6 py-16 text-center`}>
          <div className="text-sm font-medium">Backend unavailable</div>
          <div className="pt-1.5 text-(--color-text-muted)">{error.message}</div>
        </div>
      ) : repos && repos.length === 0 ? (
        <div className={`${card} flex flex-col items-center gap-1.5 px-6 py-16 text-center`}>
          <div className="text-sm font-medium">No repositories connected</div>
          <div className="max-w-md text-(--color-text-muted)">
            Install the IssueLens GitHub App and sync a repository to plot its
            issues here.
          </div>
          <Link className="pt-2 text-(--color-primary) hover:underline" href="/repositories">
            Go to Repositories →
          </Link>
        </div>
      ) : filtersActive && plotted.length === 0 && allPlottedCount > 0 ? (
        <div
          className={`${card} flex flex-col items-center gap-1.5 px-6 py-16 text-center`}
          data-testid="filter-empty"
        >
          <div className="text-sm font-medium">No issues match these filters</div>
          <div className="text-(--color-text-muted)">
            {allPlottedCount} scored issue{allPlottedCount === 1 ? "" : "s"} hidden by
            the current filters.
          </div>
          <button
            type="button"
            data-testid="clear-filters-empty"
            className="mt-2 rounded-lg border border-(--color-border) px-2.5 py-1 text-(--color-primary) transition-all duration-150 hover:bg-(--accent-tint)"
            onClick={() => navigateWith(repoId, { types: [], readiness: null })}
          >
            Clear filters
          </button>
        </div>
      ) : plotted.length === 0 ? (
        <div className={`${card} px-6 py-16 text-center text-(--color-text-muted)`}>
          No scored issues yet — scores appear after the next analysis run.
        </div>
      ) : (
        <>
          <div className="relative">
            <MatrixChart
              key={repoId ?? "none"}
              plotted={plotted}
              selectedId={selectedId}
              onSelect={setSelectedId}
              onPin={(issueId, urgency, importance) => {
                setHover(null);
                setSelectedId(issueId);
                pinMutation.mutate({ issueId, urgency, importance });
              }}
              onHover={(item, cx, cy) => setHover(item ? { item, cx, cy } : null)}
            />
            {hover ? <MatrixHoverCard item={hover.item} cx={hover.cx} cy={hover.cy} /> : null}
          </div>
          <RightRail>
            <ExecutionQueue
              plotted={plotted}
              selectedId={selectedId}
              onSelect={setSelectedId}
              onRelease={(issueId) => releaseMutation.mutate(issueId)}
            />
          </RightRail>
          {selected?.pinned ? (
            <div
              data-testid="pin-toast"
              className="fixed bottom-6 left-1/2 z-20 flex -translate-x-1/2 items-center gap-3 rounded-[14px] border border-(--color-border) bg-(--color-surface) px-4 py-2.5 shadow-(--shadow-card)"
            >
              <span>
                #{selected.number} is pinned — the AI will not move it.
              </span>
              <button
                type="button"
                data-testid="release-pin"
                className="rounded-lg border border-(--color-border) px-2.5 py-1 text-(--color-primary) transition-all duration-150 hover:bg-(--accent-tint)"
                onClick={() => releaseMutation.mutate(selected.issue_id)}
              >
                Release to AI
              </button>
              <button
                type="button"
                aria-label="Dismiss"
                className="text-(--color-text-muted) transition-all duration-150 hover:text-(--color-text)"
                onClick={() => setSelectedId(null)}
              >
                ✕
              </button>
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}
