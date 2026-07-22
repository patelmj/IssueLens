import {
  filterSummary,
  filtersFromJson,
  filtersToSearch,
  hasActiveFilters,
  parseFilters,
  type MatrixFilters,
  type ParamSource,
} from "./matrix-filters";

export const LANE_BY_VALUES = ["none", "component", "assignee"] as const;
export type BoardLaneBy = (typeof LANE_BY_VALUES)[number];

export type BoardViewFilters = MatrixFilters & { lane_by: BoardLaneBy };

function laneByOf(value: unknown): BoardLaneBy {
  return typeof value === "string" &&
    (LANE_BY_VALUES as readonly string[]).includes(value)
    ? (value as BoardLaneBy)
    : "none";
}

export function parseBoardFilters(params: ParamSource): BoardViewFilters {
  return { ...parseFilters(params), lane_by: laneByOf(params.get("lane_by")) };
}

export function boardFiltersToSearch(
  repoId: number | null,
  f: BoardViewFilters,
): string {
  const params = new URLSearchParams(filtersToSearch(repoId, f));
  if (f.lane_by !== "none") params.set("lane_by", f.lane_by);
  return params.toString();
}

/** Sanitize a saved view's JSONB filters payload (untrusted shape). */
export function boardFiltersFromJson(value: unknown): BoardViewFilters {
  const obj = (typeof value === "object" && value !== null ? value : {}) as {
    lane_by?: unknown;
  };
  return { ...filtersFromJson(value), lane_by: laneByOf(obj.lane_by) };
}

export function hasActiveBoardFilters(f: BoardViewFilters): boolean {
  return f.lane_by !== "none" || hasActiveFilters(f);
}

/** e.g. "Laned by assignee · Bug, Debt · Ready (≥80)". */
export function boardFilterSummary(f: BoardViewFilters): string {
  const parts: string[] = [];
  if (f.lane_by !== "none") parts.push(`Laned by ${f.lane_by}`);
  if (hasActiveFilters(f)) parts.push(filterSummary(f));
  return parts.length ? parts.join(" · ") : "Default board";
}
