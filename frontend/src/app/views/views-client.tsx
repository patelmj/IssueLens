"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useMemo, useRef, useState } from "react";
import { getJson, sendJson } from "../../lib/api";
import {
  fetchViews,
  reorderViews,
  savedViewHref,
  savedViewKindLabel,
  savedViewSummary,
  VIEWS_KEY,
  type SavedView,
} from "../../lib/views";

const card =
  "rounded-[14px] border border-(--color-border) bg-(--color-surface) shadow-(--shadow-card)";

const DRAG_THRESHOLD_PX = 6;

type Repo = { id: number; full_name: string };

function rowUnderPointer(x: number, y: number, repoId: number): number | null {
  const hit = document
    .elementsFromPoint(x, y)
    .find(
      (el): el is HTMLElement =>
        el instanceof HTMLElement &&
        el.dataset.viewRow != null &&
        el.dataset.repoId === String(repoId),
    );
  return hit ? Number(hit.dataset.viewRow) : null;
}

export function ViewsClient() {
  const queryClient = useQueryClient();
  const { data: views, error, isPending } = useQuery({
    queryKey: VIEWS_KEY,
    queryFn: fetchViews,
  });
  const { data: repos } = useQuery({
    queryKey: ["repositories"],
    queryFn: () => getJson<Repo[]>("/api/backend/repositories"),
  });

  const [renamingId, setRenamingId] = useState<number | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [confirmDeleteId, setConfirmDeleteId] = useState<number | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const dragRef = useRef<{
    viewId: number;
    repoId: number;
    startX: number;
    startY: number;
    active: boolean;
  } | null>(null);
  const [draggingId, setDraggingId] = useState<number | null>(null);
  const [dragTargetId, setDragTargetId] = useState<number | null>(null);

  const renameMutation = useMutation({
    mutationFn: ({ id, name }: { id: number; name: string }) =>
      sendJson<SavedView>(`/api/backend/views/${id}`, "PATCH", { name }),
    onSuccess: () => {
      setRenamingId(null);
      setActionError(null);
    },
    onError: (err) => setActionError(err.message),
    onSettled: () => queryClient.invalidateQueries({ queryKey: VIEWS_KEY }),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: number) =>
      sendJson<undefined>(`/api/backend/views/${id}`, "DELETE"),
    onSuccess: () => {
      setConfirmDeleteId(null);
      setActionError(null);
    },
    onError: (err) => setActionError(err.message),
    onSettled: () => queryClient.invalidateQueries({ queryKey: VIEWS_KEY }),
  });

  const reorderMutation = useMutation({
    mutationFn: ({
      repositoryId,
      orderedIds,
    }: {
      repositoryId: number;
      orderedIds: number[];
    }) => reorderViews(repositoryId, orderedIds),
    onMutate: async ({ repositoryId, orderedIds }) => {
      await queryClient.cancelQueries({ queryKey: VIEWS_KEY });
      const previous = queryClient.getQueryData<SavedView[]>(VIEWS_KEY);
      queryClient.setQueryData<SavedView[]>(VIEWS_KEY, (old) => {
        if (!old) return old;
        const inRepo = new Map(
          old.filter((v) => v.repository_id === repositoryId).map((v) => [v.id, v]),
        );
        const reordered = orderedIds
          .map((id) => inRepo.get(id))
          .filter((v): v is SavedView => v != null);
        return [...old.filter((v) => v.repository_id !== repositoryId), ...reordered];
      });
      setActionError(null);
      return { previous };
    },
    onError: (err, _vars, context) => {
      if (context?.previous) queryClient.setQueryData(VIEWS_KEY, context.previous);
      setActionError(err.message);
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: VIEWS_KEY }),
  });

  const repoName = (id: number | null) =>
    repos?.find((repo) => repo.id === id)?.full_name ?? "—";

  // API returns (repository_id, position, id) order, so within-group order
  // is already the user's ordering.
  const groups = useMemo(() => {
    const byRepo = new Map<number | null, SavedView[]>();
    for (const view of views ?? []) {
      byRepo.set(view.repository_id, [
        ...(byRepo.get(view.repository_id) ?? []),
        view,
      ]);
    }
    return [...byRepo.entries()]
      .map(([repoId, groupViews]) => ({
        repoId,
        name: repoName(repoId),
        views: groupViews,
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [views, repos]);

  const commitDrag = (clientX: number, clientY: number) => {
    const state = dragRef.current;
    dragRef.current = null;
    setDraggingId(null);
    setDragTargetId(null);
    if (!state?.active) return;
    const targetId = rowUnderPointer(clientX, clientY, state.repoId);
    if (targetId == null || targetId === state.viewId) return;
    const group = groups.find((g) => g.repoId === state.repoId);
    if (!group) return;
    const ids = group.views.map((v) => v.id);
    const from = ids.indexOf(state.viewId);
    ids.splice(from, 1);
    const targetIndex = ids.indexOf(targetId);
    ids.splice(from <= targetIndex ? targetIndex + 1 : targetIndex, 0, state.viewId);
    reorderMutation.mutate({ repositoryId: state.repoId, orderedIds: ids });
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-baseline gap-3">
        <h1 className="text-lg font-semibold tracking-[-0.01em]">Saved Views</h1>
        <span className="text-(--color-text-muted)">
          Your custom filters, one click away
        </span>
      </div>

      {actionError ? (
        <div className="text-(--color-danger)" data-testid="views-action-error">
          {actionError}
        </div>
      ) : null}

      {isPending ? (
        <div className={`${card} px-6 py-16 text-center text-(--color-text-muted)`}>
          Loading views…
        </div>
      ) : error ? (
        <div className={`${card} px-6 py-16 text-center`} data-testid="views-error">
          <div className="text-sm font-medium">Backend unavailable</div>
          <div className="pt-1.5 text-(--color-text-muted)">{error.message}</div>
        </div>
      ) : views && views.length === 0 ? (
        <div
          className={`${card} flex flex-col items-center gap-1.5 px-6 py-16 text-center`}
          data-testid="views-empty"
        >
          <div className="text-sm font-medium">No saved views yet</div>
          <div className="max-w-md text-(--color-text-muted)">
            Save any filtered table, matrix, or board as a named view and it will
            be listed here.
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-4" data-testid="views-list">
          {groups.map((group) => (
            <section
              key={group.repoId ?? "none"}
              data-testid={`views-repo-${group.repoId ?? "none"}`}
            >
              <h2 className="pb-1.5 text-[11px] font-semibold tracking-[0.08em] text-(--color-text-muted) uppercase">
                {group.name}
              </h2>
              <ul className={`${card} divide-y divide-(--color-border)`}>
                {group.views.map((view) => {
                  const href = savedViewHref(view);
                  return (
                    <li
                      key={view.id}
                      data-view-row={view.id}
                      data-repo-id={view.repository_id ?? ""}
                      className={`flex items-center gap-3 px-4 py-3 transition-all duration-150 ${
                        draggingId === view.id ? "opacity-60" : ""
                      } ${dragTargetId === view.id ? "bg-(--accent-tint)" : ""}`}
                      data-testid={`view-row-${view.id}`}
                    >
                      <button
                        type="button"
                        data-testid={`view-drag-${view.id}`}
                        aria-label={`Reorder ${view.name}`}
                        className="cursor-grab touch-none px-1 text-(--color-text-muted) select-none"
                        onPointerDown={(e) => {
                          if (e.button !== 0 || view.repository_id == null) return;
                          dragRef.current = {
                            viewId: view.id,
                            repoId: view.repository_id,
                            startX: e.clientX,
                            startY: e.clientY,
                            active: false,
                          };
                          e.currentTarget.setPointerCapture(e.pointerId);
                        }}
                        onPointerMove={(e) => {
                          const state = dragRef.current;
                          if (!state) return;
                          if (!state.active) {
                            const moved = Math.hypot(
                              e.clientX - state.startX,
                              e.clientY - state.startY,
                            );
                            if (moved < DRAG_THRESHOLD_PX) return;
                            state.active = true;
                            setDraggingId(state.viewId);
                          }
                          setDragTargetId(
                            rowUnderPointer(e.clientX, e.clientY, state.repoId),
                          );
                        }}
                        onPointerUp={(e) => commitDrag(e.clientX, e.clientY)}
                        onPointerCancel={() => {
                          dragRef.current = null;
                          setDraggingId(null);
                          setDragTargetId(null);
                        }}
                      >
                        ⠿
                      </button>
                      <div className="min-w-0 grow">
                        {renamingId === view.id ? (
                          <form
                            className="flex items-center gap-2"
                            onSubmit={(e) => {
                              e.preventDefault();
                              if (renameValue.trim() && !renameMutation.isPending) {
                                renameMutation.mutate({
                                  id: view.id,
                                  name: renameValue.trim(),
                                });
                              }
                            }}
                          >
                            <input
                              autoFocus
                              data-testid="view-rename-input"
                              value={renameValue}
                              onChange={(e) => setRenameValue(e.target.value)}
                              aria-label="View name"
                              className="rounded-lg border border-(--color-border) bg-(--color-bg) px-2.5 py-1"
                            />
                            <button
                              type="submit"
                              data-testid="view-rename-save"
                              disabled={
                                !renameValue.trim() || renameMutation.isPending
                              }
                              className="rounded-lg bg-(--accent-tint) px-2.5 py-1 font-medium text-(--color-primary) transition-all duration-150 disabled:opacity-60"
                            >
                              Save
                            </button>
                            <button
                              type="button"
                              data-testid="view-rename-cancel"
                              className="text-(--color-text-muted) transition-all duration-150 hover:text-(--color-text)"
                              onClick={() => setRenamingId(null)}
                            >
                              Cancel
                            </button>
                          </form>
                        ) : (
                          <div className="flex items-center gap-2">
                            <span className="truncate font-medium">{view.name}</span>
                            <span className="rounded-full border border-(--color-border) px-1.5 text-[10px] text-(--color-text-muted) uppercase">
                              {savedViewKindLabel(view)}
                            </span>
                          </div>
                        )}
                        <div className="truncate pt-0.5 text-(--color-text-muted)">
                          {savedViewSummary(view)}
                        </div>
                      </div>
                      {href != null ? (
                        <Link
                          href={href}
                          data-testid={`view-open-${view.id}`}
                          className="rounded-lg border border-(--color-border) px-2.5 py-1 text-(--color-primary) transition-all duration-150 hover:bg-(--accent-tint)"
                        >
                          Open
                        </Link>
                      ) : null}
                      <button
                        type="button"
                        data-testid={`view-rename-${view.id}`}
                        className="rounded-lg border border-(--color-border) px-2.5 py-1 text-(--color-text-muted) transition-all duration-150 hover:text-(--color-text)"
                        onClick={() => {
                          setRenamingId(view.id);
                          setRenameValue(view.name);
                          setConfirmDeleteId(null);
                          setActionError(null);
                        }}
                      >
                        Rename
                      </button>
                      <button
                        type="button"
                        data-testid={`view-delete-${view.id}`}
                        disabled={
                          deleteMutation.isPending && confirmDeleteId === view.id
                        }
                        className={`rounded-lg border px-2.5 py-1 transition-all duration-150 disabled:opacity-60 ${
                          confirmDeleteId === view.id
                            ? "border-(--color-danger) text-(--color-danger)"
                            : "border-(--color-border) text-(--color-text-muted) hover:text-(--color-text)"
                        }`}
                        onClick={() => {
                          if (confirmDeleteId === view.id) {
                            if (!deleteMutation.isPending) {
                              deleteMutation.mutate(view.id);
                            }
                          } else {
                            setConfirmDeleteId(view.id);
                            setRenamingId(null);
                            setActionError(null);
                          }
                        }}
                      >
                        {confirmDeleteId === view.id ? "Confirm delete" : "Delete"}
                      </button>
                    </li>
                  );
                })}
              </ul>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}
