export type PriorityFactor = {
  axis: "urgency" | "importance";
  sign: "+" | "-";
  text: string;
  source: "signal" | "llm";
  weight: number;
};

export type MatrixItem = {
  issue_id: number;
  number: number;
  title: string;
  urgency: number | null;
  importance: number | null;
  factors: PriorityFactor[];
  issue_type: "bug" | "feature" | "debt" | "question" | "docs" | null;
  component: string | null;
  readiness_score: number | null;
  labels: { name: string; color: string }[];
  assignees: string[];
  estimate: number;
  pinned: boolean;
  pinned_urgency: number | null;
  pinned_importance: number | null;
  scored_at: string | null;
  model: string | null;
};

export type MatrixPayload = {
  items: MatrixItem[];
  total: number;
  scored: number;
  unscored: number;
};

/** An item with effective (pin-overridden) coordinates, ready to plot. */
export type PlottedItem = MatrixItem & { u: number; i: number };

export type Quadrant = "dofirst" | "schedule" | "delegate" | "reconsider";

export type Series = "bug" | "feature" | "debt" | "other";

export function toPlotted(items: MatrixItem[]): PlottedItem[] {
  return items.flatMap((item) => {
    const u = item.pinned ? item.pinned_urgency : item.urgency;
    const i = item.pinned ? item.pinned_importance : item.importance;
    return u == null || i == null ? [] : [{ ...item, u, i }];
  });
}

export function quadrantOf(item: PlottedItem): Quadrant {
  if (item.u >= 50) return item.i >= 50 ? "dofirst" : "delegate";
  return item.i >= 50 ? "schedule" : "reconsider";
}

export function seriesOfType(issueType: string | null): Series {
  if (issueType === "bug" || issueType === "feature" || issueType === "debt") {
    return issueType;
  }
  return "other";
}

export function seriesOf(item: MatrixItem): Series {
  return seriesOfType(item.issue_type);
}

export const SERIES_VAR: Record<Series, string> = {
  bug: "var(--pm-bug)",
  feature: "var(--pm-feature)",
  debt: "var(--pm-debt)",
  other: "var(--pm-other)",
};

export const QUADRANT_LABEL: Record<Quadrant, string> = {
  dofirst: "Do First",
  schedule: "Schedule",
  delegate: "Delegate",
  reconsider: "Reconsider",
};
