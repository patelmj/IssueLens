import type { ParamSource } from "./matrix-filters";

export const TABLE_STATES = ["open", "closed", "all"] as const;
export type TableState = (typeof TABLE_STATES)[number];

export const TABLE_SORTS = [
  "updated",
  "created",
  "comments",
  "number",
  "title",
  "readiness",
] as const;
export type TableSort = (typeof TABLE_SORTS)[number];

/** Values offered by the table toolbar; anything else is dropped on parse. */
export const TABLE_TYPES = ["bug", "feature", "debt", "question", "docs"] as const;

export type TableViewFilters = {
  state: TableState;
  label: string | null;
  assignee: string | null;
  q: string | null;
  type: string | null;
  component: string | null;
  max_readiness: string | null;
  sort: TableSort;
  order: "asc" | "desc";
};

export const TABLE_DEFAULTS: TableViewFilters = {
  state: "open",
  label: null,
  assignee: null,
  q: null,
  type: null,
  component: null,
  max_readiness: null,
  sort: "updated",
  order: "desc",
};

function cleanString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function oneOf<T extends string>(
  value: unknown,
  allowed: readonly T[],
  fallback: T,
): T {
  return typeof value === "string" && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : fallback;
}

function memberOrNull(value: unknown, allowed: readonly string[]): string | null {
  return typeof value === "string" && allowed.includes(value) ? value : null;
}

/**
 * Readiness-percentage sanitizer: accepts any integer 0-100 inclusive, not just the
 * toolbar's preset thresholds — a hand-typed `?max_readiness=80` is a valid backend
 * query (`ge=0, le=100` in issues.py) and must survive the saved-view round-trip.
 * Canonicalizes to a plain decimal string (no leading zeros) so "050" and "50" collapse
 * to the same value and always produce the same query string. Anything else
 * (non-numeric, negative, >100, non-integer) is dropped to null, same as an unrecognized
 * preset used to be.
 */
export function percentOrNull(value: unknown): string | null {
  if (typeof value !== "string" || !/^\d{1,3}$/.test(value)) return null;
  const n = Number(value);
  return n >= 0 && n <= 100 ? String(n) : null;
}

/** Unknown or malformed values fall back to defaults — never a crash. */
export function parseTableFilters(params: ParamSource): TableViewFilters {
  return {
    state: oneOf(params.get("state"), TABLE_STATES, "open"),
    label: cleanString(params.get("label")),
    assignee: cleanString(params.get("assignee")),
    q: cleanString(params.get("q")),
    type: memberOrNull(params.get("type"), TABLE_TYPES),
    component: cleanString(params.get("component")),
    max_readiness: percentOrNull(params.get("max_readiness")),
    sort: oneOf(params.get("sort"), TABLE_SORTS, "updated"),
    order: oneOf(params.get("order"), ["asc", "desc"] as const, "desc"),
  };
}

/** Canonical query string — only non-default values, stable key order. */
export function tableFiltersToSearch(
  repoId: number | null,
  f: TableViewFilters,
): string {
  const params = new URLSearchParams();
  if (repoId != null) params.set("repo_id", String(repoId));
  if (f.state !== "open") params.set("state", f.state);
  if (f.q) params.set("q", f.q);
  if (f.label) params.set("label", f.label);
  if (f.assignee) params.set("assignee", f.assignee);
  if (f.type) params.set("type", f.type);
  if (f.component) params.set("component", f.component);
  if (f.max_readiness) params.set("max_readiness", f.max_readiness);
  if (f.sort !== "updated") params.set("sort", f.sort);
  if (f.order !== "desc") params.set("order", f.order);
  return params.toString();
}

/** Sanitize a saved view's JSONB filters payload (untrusted shape). */
export function tableFiltersFromJson(value: unknown): TableViewFilters {
  const obj = (typeof value === "object" && value !== null ? value : {}) as Record<
    string,
    unknown
  >;
  return {
    state: oneOf(obj.state, TABLE_STATES, "open"),
    label: cleanString(obj.label),
    assignee: cleanString(obj.assignee),
    q: cleanString(obj.q),
    type: memberOrNull(obj.type, TABLE_TYPES),
    component: cleanString(obj.component),
    max_readiness: percentOrNull(obj.max_readiness),
    sort: oneOf(obj.sort, TABLE_SORTS, "updated"),
    order: oneOf(obj.order, ["asc", "desc"] as const, "desc"),
  };
}

export function hasActiveTableFilters(f: TableViewFilters): boolean {
  return (Object.keys(TABLE_DEFAULTS) as (keyof TableViewFilters)[]).some(
    (key) => f[key] !== TABLE_DEFAULTS[key],
  );
}

const STATE_LABEL: Record<TableState, string> = {
  open: "Open",
  closed: "Closed",
  all: "All states",
};

/** Human-readable summary, e.g. "Open · bug · readiness <50% · by readiness ↑". */
export function tableFilterSummary(f: TableViewFilters): string {
  const parts: string[] = [STATE_LABEL[f.state]];
  if (f.q) parts.push(`"${f.q}"`);
  if (f.type) parts.push(f.type);
  if (f.component) parts.push(f.component);
  if (f.label) parts.push(f.label);
  if (f.assignee) parts.push(`@${f.assignee}`);
  if (f.max_readiness) parts.push(`readiness <${f.max_readiness}%`);
  if (f.sort !== "updated" || f.order !== "desc") {
    parts.push(`by ${f.sort} ${f.order === "asc" ? "↑" : "↓"}`);
  }
  return parts.join(" · ");
}
