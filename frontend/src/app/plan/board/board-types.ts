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
