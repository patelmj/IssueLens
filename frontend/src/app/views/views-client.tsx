"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useState } from "react";
import { getJson, sendJson } from "../../lib/api";
import { filterSummary, filtersFromJson } from "../../lib/matrix-filters";
import { fetchViews, savedViewHref, VIEWS_KEY, type SavedView } from "../../lib/views";

const card =
  "rounded-[14px] border border-(--color-border) bg-(--color-surface) shadow-(--shadow-card)";

type Repo = { id: number; full_name: string };

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

  const repoName = (id: number | null) =>
    repos?.find((repo) => repo.id === id)?.full_name ?? "—";

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
            Save any filtered table or board as a named view and it will be listed
            here.
          </div>
        </div>
      ) : (
        <ul className={`${card} divide-y divide-(--color-border)`} data-testid="views-list">
          {(views ?? []).map((view) => (
            <li
              key={view.id}
              className="flex items-center gap-3 px-4 py-3"
              data-testid={`view-row-${view.id}`}
            >
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
                      disabled={!renameValue.trim() || renameMutation.isPending}
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
                      {view.view_kind === "matrix" ? "Matrix" : view.view_kind}
                    </span>
                  </div>
                )}
                <div className="truncate pt-0.5 text-(--color-text-muted)">
                  {repoName(view.repository_id)} ·{" "}
                  {filterSummary(filtersFromJson(view.filters))}
                </div>
              </div>
              <Link
                href={savedViewHref(view)}
                data-testid={`view-open-${view.id}`}
                className="rounded-lg border border-(--color-border) px-2.5 py-1 text-(--color-primary) transition-all duration-150 hover:bg-(--accent-tint)"
              >
                Open
              </Link>
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
                disabled={deleteMutation.isPending && confirmDeleteId === view.id}
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
          ))}
        </ul>
      )}
    </div>
  );
}
