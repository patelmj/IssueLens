export type WorkflowColumn =
  | "needs_detail"
  | "ready"
  | "in_progress"
  | "review"
  | "blocked"
  | "done";

export type KanbanCard = {
  issue_id: number;
  number: number;
  title: string;
  component: string | null;
  issue_type: string | null;
  priority_band: "dofirst" | "schedule" | "delegate" | "reconsider" | null;
  readiness_pct: number | null;
  estimate: number;
  assignees: string[];
  gh_updated_at: string;
  warning: string | null;
  placed: boolean;
};

export type KanbanColumn = { key: WorkflowColumn; cards: KanbanCard[] };

export type KanbanPayload = { columns: KanbanColumn[]; total: number };

export const COLUMN_ORDER: WorkflowColumn[] = [
  "needs_detail", "ready", "in_progress", "review", "blocked", "done",
];

export const COLUMN_LABEL: Record<WorkflowColumn, string> = {
  needs_detail: "Needs Detail",
  ready: "Ready",
  in_progress: "In Progress",
  review: "Review",
  blocked: "Blocked",
  done: "Done",
};

export const BAND_LABEL: Record<
  NonNullable<KanbanCard["priority_band"]>,
  string
> = {
  dofirst: "Do First",
  schedule: "Schedule",
  delegate: "Delegate",
  reconsider: "Reconsider",
};

/** Optimistically move a card to another column (placed=true, inserted on top). */
export function movedPayload(
  payload: KanbanPayload,
  issueId: number,
  to: WorkflowColumn,
): KanbanPayload {
  let moved: KanbanCard | null = null;
  const stripped = payload.columns.map((col) => {
    const found = col.cards.find((c) => c.issue_id === issueId);
    if (found) moved = { ...found, placed: true };
    return { ...col, cards: col.cards.filter((c) => c.issue_id !== issueId) };
  });
  if (!moved) return payload;
  return {
    ...payload,
    columns: stripped.map((col) =>
      col.key === to ? { ...col, cards: [moved!, ...col.cards] } : col,
    ),
  };
}

export type LaneBy = "none" | "component" | "assignee";

export const FALLBACK_LANE: Record<Exclude<LaneBy, "none">, string> = {
  component: "Uncategorized",
  assignee: "Unassigned",
};

function laneKeyOf(card: KanbanCard, laneBy: Exclude<LaneBy, "none">): string {
  if (laneBy === "component") return card.component ?? FALLBACK_LANE.component;
  return card.assignees[0] ?? FALLBACK_LANE.assignee;
}

/** Split the payload into swimlanes; a single unnamed lane when laneBy is "none". */
export function lanesFor(
  payload: KanbanPayload,
  laneBy: LaneBy,
): { lane: string; columns: KanbanColumn[] }[] {
  if (laneBy === "none") return [{ lane: "", columns: payload.columns }];
  const fallback = FALLBACK_LANE[laneBy];
  const names = new Set<string>();
  for (const col of payload.columns) {
    for (const c of col.cards) names.add(laneKeyOf(c, laneBy));
  }
  const ordered = [
    ...[...names].filter((n) => n !== fallback).sort((a, b) => a.localeCompare(b)),
    ...(names.has(fallback) ? [fallback] : []),
  ];
  return ordered.map((lane) => ({
    lane,
    columns: payload.columns.map((col) => ({
      ...col,
      cards: col.cards.filter((c) => laneKeyOf(c, laneBy) === lane),
    })),
  }));
}
