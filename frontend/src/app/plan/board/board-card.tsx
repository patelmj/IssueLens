"use client";

import { useRef, useState } from "react";
import { relativeTime } from "../../../lib/time";
import {
  BAND_LABEL,
  COLUMN_LABEL,
  COLUMN_ORDER,
  type KanbanCard,
  type WorkflowColumn,
} from "./board-types";

const DRAG_THRESHOLD_PX = 6;

type BoardCardProps = {
  card: KanbanCard;
  column: WorkflowColumn;
  onMove: (issueId: number, to: WorkflowColumn) => void;
  onReset: (issueId: number) => void;
  onDragTarget: (column: WorkflowColumn | null) => void;
};

function columnUnderPointer(x: number, y: number): WorkflowColumn | null {
  const hit = document
    .elementsFromPoint(x, y)
    .find((el): el is HTMLElement => el instanceof HTMLElement && !!el.dataset.wfColumn);
  return (hit?.dataset.wfColumn as WorkflowColumn | undefined) ?? null;
}

export function BoardCard({ card, column, onMove, onReset, onDragTarget }: BoardCardProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [dragging, setDragging] = useState(false);
  const drag = useRef<{ startX: number; startY: number; active: boolean } | null>(null);

  const finishDrag = (commitTo: WorkflowColumn | null) => {
    if (drag.current?.active) {
      if (commitTo && commitTo !== column) onMove(card.issue_id, commitTo);
      setDragging(false);
    }
    drag.current = null;
    onDragTarget(null);
  };

  const meta = [
    card.component,
    card.issue_type,
    card.priority_band ? BAND_LABEL[card.priority_band] : null,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <article
      data-testid={`card-${card.number}`}
      tabIndex={0}
      className={`relative flex touch-none select-none flex-col gap-1 rounded-[10px] border border-(--color-border) bg-(--color-surface) p-2.5 shadow-(--shadow-card) ${
        dragging ? "opacity-60" : ""
      }`}
      onPointerDown={(e) => {
        if (e.button !== 0 || (e.target as HTMLElement).closest("button")) return;
        drag.current = { startX: e.clientX, startY: e.clientY, active: false };
        e.currentTarget.setPointerCapture(e.pointerId);
      }}
      onPointerMove={(e) => {
        const state = drag.current;
        if (!state) return;
        if (!state.active) {
          const moved = Math.hypot(e.clientX - state.startX, e.clientY - state.startY);
          if (moved < DRAG_THRESHOLD_PX) return;
          state.active = true;
          setDragging(true);
        }
        onDragTarget(columnUnderPointer(e.clientX, e.clientY));
      }}
      onPointerUp={(e) => finishDrag(columnUnderPointer(e.clientX, e.clientY))}
      onPointerCancel={() => finishDrag(null)}
    >
      <div className="flex items-start gap-1.5">
        <span className="font-medium text-(--color-text-muted)">#{card.number}</span>
        <span className="grow font-medium">{card.title}</span>
        <button
          type="button"
          data-testid={`card-menu-${card.number}`}
          aria-label={`Actions for #${card.number}`}
          aria-expanded={menuOpen}
          className="rounded px-1 text-(--color-text-muted) transition-all duration-150 hover:bg-(--accent-tint) hover:text-(--color-text)"
          onClick={() => setMenuOpen((open) => !open)}
        >
          ⋯
        </button>
      </div>
      {menuOpen ? (
        <div className="absolute top-8 right-2 z-10 flex w-44 flex-col rounded-[10px] border border-(--color-border) bg-(--color-surface) p-1 shadow-(--shadow-card)">
          {COLUMN_ORDER.filter((key) => key !== column).map((key) => (
            <button
              key={key}
              type="button"
              data-testid={`menu-move-${card.number}-${key}`}
              className="rounded-lg px-2 py-1 text-left transition-all duration-150 hover:bg-(--accent-tint)"
              onClick={() => {
                setMenuOpen(false);
                onMove(card.issue_id, key);
              }}
            >
              Move to {COLUMN_LABEL[key]}
            </button>
          ))}
          {card.placed ? (
            <button
              type="button"
              data-testid={`menu-reset-${card.number}`}
              className="rounded-lg px-2 py-1 text-left text-(--color-primary) transition-all duration-150 hover:bg-(--accent-tint)"
              onClick={() => {
                setMenuOpen(false);
                onReset(card.issue_id);
              }}
            >
              Reset to auto
            </button>
          ) : null}
        </div>
      ) : null}
      {meta ? (
        <div className="text-[11px] text-(--color-text-muted)">{meta}</div>
      ) : null}
      <div className="text-[11px] text-(--color-text-muted)">
        {card.readiness_pct != null ? `Readiness ${card.readiness_pct}%` : "Unscored"}
        {" · "}Est {card.estimate}
        {card.assignees.length ? ` · ${card.assignees.join(", ")}` : ""}
        {" · "}
        {relativeTime(card.gh_updated_at)}
      </div>
      {card.warning ? (
        <div
          data-testid={`card-warning-${card.number}`}
          className="text-[11px] text-(--pm-other)"
        >
          ⚠ {card.warning}
        </div>
      ) : null}
      {card.placed ? (
        <span
          data-testid={`card-placed-${card.number}`}
          className="self-start rounded-full border border-(--color-border) px-1.5 text-[10px] text-(--color-text-muted)"
        >
          placed
        </span>
      ) : null}
    </article>
  );
}
