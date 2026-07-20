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
import { PlanTabs } from "../plan-tabs";
import {
  toPlotted,
  type MatrixItem,
  type MatrixPayload,
} from "./matrix-types";

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

  const { data, error, isPending } = useQuery({
    queryKey: matrixKey,
    queryFn: () => getJson<MatrixPayload>(`/api/backend/repositories/${repoId}/priority`),
    enabled: repoId != null,
    placeholderData: keepPreviousData,
  });

  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [mutationError, setMutationError] = useState<string | null>(null);

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

  const items = data?.items ?? [];
  const plotted = toPlotted(items);
  const selected = items.find((item) => item.issue_id === selectedId) ?? null;

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
            router.replace(
              e.target.value ? `/plan/matrix?repo_id=${e.target.value}` : "/plan/matrix",
              { scroll: false },
            )
          }
        >
          {(repos ?? []).map((repo) => (
            <option key={repo.id} value={repo.id}>
              {repo.full_name}
            </option>
          ))}
        </select>
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
      ) : plotted.length === 0 ? (
        <div className={`${card} px-6 py-16 text-center text-(--color-text-muted)`}>
          No scored issues yet — scores appear after the next analysis run.
        </div>
      ) : (
        <MatrixBoard
          plotted={plotted}
          selected={selected}
          onSelect={setSelectedId}
          onPin={(issueId, urgency, importance) =>
            pinMutation.mutate({ issueId, urgency, importance })
          }
          onRelease={(issueId) => releaseMutation.mutate(issueId)}
        />
      )}
    </div>
  );
}

/** Placeholder container — replaced by chart + queue in the next two tasks. */
function MatrixBoard(props: {
  plotted: ReturnType<typeof toPlotted>;
  selected: MatrixItem | null;
  onSelect: (id: number | null) => void;
  onPin: (issueId: number, urgency: number, importance: number) => void;
  onRelease: (issueId: number) => void;
}) {
  return (
    <div className={`${card} p-4 text-(--color-text-muted)`} data-testid="matrix-board">
      {props.plotted.length} scored issues ready to plot.
    </div>
  );
}
