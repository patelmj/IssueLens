"use client";

import {
  keepPreviousData,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";
import { getJson, sendJson } from "../../../lib/api";
import { PlanTabs } from "../plan-tabs";
import { BoardCard } from "./board-card";
import {
  COLUMN_LABEL,
  lanesFor,
  movedPayload,
  type KanbanPayload,
  type LaneBy,
  type WorkflowColumn,
} from "./board-types";

const card =
  "rounded-[14px] border border-(--color-border) bg-(--color-surface) shadow-(--shadow-card)";

type Repo = { id: number; full_name: string };

export function BoardClient() {
  const searchParams = useSearchParams();
  const router = useRouter();

  const { data: repos, isPending: reposPending } = useQuery({
    queryKey: ["repositories"],
    queryFn: () => getJson<Repo[]>("/api/backend/repositories"),
  });

  const repoParam = searchParams.get("repo_id");
  const repoId = repoParam ? Number(repoParam) : (repos?.[0]?.id ?? null);
  const kanbanKey = ["kanban", repoId] as const;

  const { data, error, isPending } = useQuery({
    queryKey: kanbanKey,
    queryFn: () => getJson<KanbanPayload>(`/api/backend/repositories/${repoId}/kanban`),
    enabled: repoId != null,
    placeholderData: keepPreviousData,
  });

  const queryClient = useQueryClient();
  const [dropTarget, setDropTarget] = useState<WorkflowColumn | null>(null);
  const [moveError, setMoveError] = useState<string | null>(null);
  const [laneBy, setLaneBy] = useState<LaneBy>("none");

  const moveMutation = useMutation({
    mutationFn: ({ issueId, column }: { issueId: number; column: WorkflowColumn }) =>
      sendJson<{ issue_id: number }>(`/api/backend/issues/${issueId}/workflow`, "PUT", {
        column,
      }),
    onMutate: async ({ issueId, column }) => {
      await queryClient.cancelQueries({ queryKey: kanbanKey });
      const previous = queryClient.getQueryData<KanbanPayload>(kanbanKey);
      queryClient.setQueryData<KanbanPayload>(kanbanKey, (old) =>
        old ? movedPayload(old, issueId, column) : old,
      );
      setMoveError(null);
      return { previous };
    },
    onError: (err, _vars, context) => {
      if (context?.previous) queryClient.setQueryData(kanbanKey, context.previous);
      setMoveError(err.message);
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: kanbanKey }),
  });

  const resetMutation = useMutation({
    mutationFn: (issueId: number) =>
      sendJson<undefined>(`/api/backend/issues/${issueId}/workflow`, "DELETE"),
    onMutate: async () => {
      await queryClient.cancelQueries({ queryKey: kanbanKey });
      setMoveError(null);
      return { previous: queryClient.getQueryData<KanbanPayload>(kanbanKey) };
    },
    onError: (err, _vars, context) => {
      if (context?.previous) queryClient.setQueryData(kanbanKey, context.previous);
      setMoveError(err.message);
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: kanbanKey }),
  });

  const lanes = data ? lanesFor(data, laneBy) : [];

  return (
    <div className="flex flex-col gap-4" data-testid="board-content">
      <div className="flex items-baseline gap-3">
        <h1 className="text-lg font-semibold tracking-[-0.01em]">Plan</h1>
        <span className="text-(--color-text-muted)">
          Workflow board — drag a card to move it
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
              e.target.value ? `/plan/board?repo_id=${e.target.value}` : "/plan/board",
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
        <div
          className="flex items-center gap-0.5 rounded-[9px] border border-(--color-border) bg-(--color-surface) p-0.5"
          data-testid="lane-by"
        >
          {(
            [
              ["none", "None"],
              ["component", "Component"],
              ["assignee", "Assignee"],
            ] as const
          ).map(([value, label]) => (
            <button
              key={value}
              type="button"
              aria-pressed={laneBy === value}
              className={`rounded-[7px] px-2.5 py-1 transition-all duration-150 ${
                laneBy === value
                  ? "bg-(--accent-tint) font-medium text-(--color-primary)"
                  : "text-(--color-text-muted) hover:text-(--color-text)"
              }`}
              onClick={() => setLaneBy(value)}
            >
              {label}
            </button>
          ))}
        </div>
        {moveError ? (
          <span className="text-(--color-danger)" data-testid="move-error">
            {moveError}
          </span>
        ) : null}
      </div>

      {reposPending || (repoId != null && isPending) ? (
        <div className={`${card} px-6 py-16 text-center text-(--color-text-muted)`}>
          Loading board…
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
            Install the IssueLens GitHub App and sync a repository to see its
            issues here.
          </div>
          <Link className="pt-2 text-(--color-primary) hover:underline" href="/repositories">
            Go to Repositories →
          </Link>
        </div>
      ) : (
        <div className="overflow-x-auto pb-2">
          <div className="flex min-w-[1080px] flex-col gap-4">
            {lanes.map(({ lane, columns }) => (
              <div key={lane || "all"} data-testid={`swimlane-${lane || "all"}`}>
                {lane ? (
                  <div className="pb-1.5 text-[11px] font-semibold tracking-[0.08em] text-(--color-text-muted) uppercase">
                    {lane}
                  </div>
                ) : null}
                <div className="grid grid-cols-6 gap-3">
                  {columns.map((col) => (
                    <section
                      key={col.key}
                      data-wf-column={col.key}
                      data-testid={`col-${col.key}`}
                      className={`flex flex-col gap-2 rounded-[10px] transition-all duration-150 ${
                        dropTarget === col.key ? "bg-(--accent-tint)" : ""
                      }`}
                    >
                      <header
                        className={`flex items-baseline justify-between rounded-[10px] border border-(--color-border) px-2.5 py-1.5 ${
                          col.cards.length === 0 ? "opacity-60" : ""
                        }`}
                      >
                        <span className="text-[11px] font-semibold tracking-[0.06em] uppercase">
                          {COLUMN_LABEL[col.key]}
                        </span>
                        <span className="text-[10px] text-(--color-text-muted)">
                          {col.cards.length}
                        </span>
                      </header>
                      <div className="flex min-h-24 flex-col gap-2">
                        {col.cards.map((c) => (
                          <BoardCard
                            key={c.issue_id}
                            card={c}
                            column={col.key}
                            onMove={(issueId, to) =>
                              moveMutation.mutate({ issueId, column: to })
                            }
                            onReset={(issueId) => resetMutation.mutate(issueId)}
                            onDragTarget={setDropTarget}
                          />
                        ))}
                      </div>
                    </section>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
