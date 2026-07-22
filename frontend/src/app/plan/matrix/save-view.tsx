"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { sendJson } from "../../../lib/api";
import { hasActiveFilters, type MatrixFilters } from "../../../lib/matrix-filters";
import { VIEWS_KEY, type SavedView } from "../../../lib/views";

const panel =
  "absolute right-0 top-full z-30 mt-1 flex w-60 flex-col gap-2 rounded-lg border border-(--color-border) bg-(--color-surface) p-2.5 shadow-(--shadow-card)";

export function SaveViewButton({
  repoId,
  filters,
}: {
  repoId: number | null;
  filters: MatrixFilters;
}) {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const rootRef = useRef<HTMLDivElement>(null);
  const canSave = repoId != null && hasActiveFilters(filters);

  const mutation = useMutation({
    mutationFn: () =>
      sendJson<SavedView>("/api/backend/views", "POST", {
        name: name.trim(),
        view_kind: "matrix",
        repository_id: repoId,
        filters: { types: filters.types, readiness: filters.readiness },
      }),
    onSuccess: () => {
      setOpen(false);
      setName("");
      queryClient.invalidateQueries({ queryKey: VIEWS_KEY });
    },
  });

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        data-testid="save-view"
        disabled={!canSave}
        className="rounded-lg border border-(--color-border) bg-(--color-surface) px-2.5 py-1.5 text-(--color-primary) transition-all duration-150 enabled:hover:bg-(--accent-tint) disabled:text-(--color-text-muted) disabled:opacity-60"
        onClick={() => {
          mutation.reset();
          setOpen(!open);
        }}
      >
        Save view
      </button>
      {open ? (
        <form
          data-testid="save-view-popover"
          className={panel}
          onSubmit={(e) => {
            e.preventDefault();
            if (name.trim() && !mutation.isPending) mutation.mutate();
          }}
        >
          <input
            autoFocus
            data-testid="save-view-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="View name"
            aria-label="View name"
            className="rounded-lg border border-(--color-border) bg-(--color-bg) px-2.5 py-1.5"
          />
          <button
            type="submit"
            data-testid="save-view-submit"
            disabled={!name.trim() || mutation.isPending}
            className="rounded-lg bg-(--accent-tint) px-2.5 py-1.5 font-medium text-(--color-primary) transition-all duration-150 disabled:opacity-60"
          >
            {mutation.isPending ? "Saving…" : "Save"}
          </button>
          {mutation.isError ? (
            <div data-testid="save-view-error" className="text-(--color-danger)">
              {mutation.error.message}
            </div>
          ) : null}
        </form>
      ) : null}
    </div>
  );
}
