"use client";

import { relativeTime } from "../../../lib/time";
import { BAND_LABEL, type KanbanCard } from "./board-types";

export function BoardCard({ card }: { card: KanbanCard }) {
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
      className="flex flex-col gap-1 rounded-[10px] border border-(--color-border) bg-(--color-surface) p-2.5 shadow-(--shadow-card)"
    >
      <div className="flex items-start gap-1.5">
        <span className="font-medium text-(--color-text-muted)">#{card.number}</span>
        <span className="grow font-medium">{card.title}</span>
      </div>
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
