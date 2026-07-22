import { getJson, sendJson } from "./api";
import {
  filterSummary,
  filtersFromJson,
  filtersToSearch,
} from "./matrix-filters";
import {
  tableFilterSummary,
  tableFiltersFromJson,
  tableFiltersToSearch,
} from "./table-filters";
import {
  boardFilterSummary,
  boardFiltersFromJson,
  boardFiltersToSearch,
} from "./board-filters";

export type SavedView = {
  id: number;
  name: string;
  view_kind: string;
  repository_id: number | null;
  filters: unknown;
  position: number;
  created_at: string;
};

export const VIEWS_KEY = ["views"] as const;

export function fetchViews(): Promise<SavedView[]> {
  return getJson<SavedView[]>("/api/backend/views");
}

type KindMeta = {
  label: string;
  href: (view: SavedView) => string;
  summary: (view: SavedView) => string;
};

const withSearch = (route: string, search: string) =>
  search ? `${route}?${search}` : route;

const VIEW_KIND_META: Record<string, KindMeta> = {
  matrix: {
    label: "Matrix",
    href: (view) =>
      withSearch(
        "/plan/matrix",
        filtersToSearch(view.repository_id, filtersFromJson(view.filters)),
      ),
    summary: (view) => filterSummary(filtersFromJson(view.filters)),
  },
  table: {
    label: "Table",
    href: (view) =>
      withSearch(
        "/plan",
        tableFiltersToSearch(view.repository_id, tableFiltersFromJson(view.filters)),
      ),
    summary: (view) => tableFilterSummary(tableFiltersFromJson(view.filters)),
  },
  board: {
    label: "Board",
    href: (view) =>
      withSearch(
        "/plan/board",
        boardFiltersToSearch(view.repository_id, boardFiltersFromJson(view.filters)),
      ),
    summary: (view) => boardFilterSummary(boardFiltersFromJson(view.filters)),
  },
};

/** Deep link that re-applies a view's repo + filters; null for unknown kinds. */
export function savedViewHref(view: SavedView): string | null {
  return VIEW_KIND_META[view.view_kind]?.href(view) ?? null;
}

export function savedViewKindLabel(view: SavedView): string {
  return VIEW_KIND_META[view.view_kind]?.label ?? view.view_kind;
}

export function savedViewSummary(view: SavedView): string {
  return VIEW_KIND_META[view.view_kind]?.summary(view) ?? "—";
}

export function reorderViews(
  repositoryId: number,
  orderedIds: number[],
): Promise<SavedView[]> {
  return sendJson<SavedView[]>("/api/backend/views/order", "PUT", {
    repository_id: repositoryId,
    ordered_ids: orderedIds,
  });
}
