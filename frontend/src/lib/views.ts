import { getJson } from "./api";
import { filtersFromJson, filtersToSearch } from "./matrix-filters";

export type SavedView = {
  id: number;
  name: string;
  view_kind: string;
  repository_id: number | null;
  filters: unknown;
  created_at: string;
};

export const VIEWS_KEY = ["views"] as const;

export function fetchViews(): Promise<SavedView[]> {
  return getJson<SavedView[]>("/api/backend/views");
}

/** Deep link that re-applies a matrix view's repo + filters. */
export function savedViewHref(view: SavedView): string {
  const search = filtersToSearch(view.repository_id, filtersFromJson(view.filters));
  return search ? `/plan/matrix?${search}` : "/plan/matrix";
}
