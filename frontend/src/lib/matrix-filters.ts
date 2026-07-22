export const ISSUE_TYPE_FILTERS = [
  "bug",
  "feature",
  "debt",
  "question",
  "docs",
  "unclassified",
] as const;
export type TypeFilter = (typeof ISSUE_TYPE_FILTERS)[number];

export const TYPE_LABEL: Record<TypeFilter, string> = {
  bug: "Bug",
  feature: "Feature",
  debt: "Debt",
  question: "Question",
  docs: "Docs",
  unclassified: "Unclassified",
};

export const READINESS_ORDER = ["ready", "almost", "needswork", "unscored"] as const;
export type ReadinessBucket = (typeof READINESS_ORDER)[number];

export const READINESS_BUCKETS: Record<ReadinessBucket, { label: string }> = {
  ready: { label: "Ready (≥80)" },
  almost: { label: "Almost (50–79)" },
  needswork: { label: "Needs work (<50)" },
  unscored: { label: "Unscored" },
};

export type MatrixFilters = {
  /** Empty = all types. */
  types: TypeFilter[];
  /** null = any readiness. */
  readiness: ReadinessBucket | null;
};

export const NO_FILTERS: MatrixFilters = { types: [], readiness: null };

type ParamSource = { get(name: string): string | null };

/** Unknown or malformed values are ignored — never a crash. */
export function parseFilters(params: ParamSource): MatrixFilters {
  const types = (params.get("types") ?? "")
    .split(",")
    .filter((t): t is TypeFilter =>
      (ISSUE_TYPE_FILTERS as readonly string[]).includes(t),
    );
  const rawReadiness = params.get("readiness");
  const readiness = (READINESS_ORDER as readonly string[]).includes(rawReadiness ?? "")
    ? (rawReadiness as ReadinessBucket)
    : null;
  return { types: [...new Set(types)], readiness };
}

export function filtersToSearch(repoId: number | null, filters: MatrixFilters): string {
  const params = new URLSearchParams();
  if (repoId != null) params.set("repo_id", String(repoId));
  if (filters.types.length) params.set("types", filters.types.join(","));
  if (filters.readiness) params.set("readiness", filters.readiness);
  return params.toString();
}

/** Sanitize a saved view's JSONB filters payload (untrusted shape). */
export function filtersFromJson(value: unknown): MatrixFilters {
  const obj = (typeof value === "object" && value !== null ? value : {}) as {
    types?: unknown;
    readiness?: unknown;
  };
  const types = Array.isArray(obj.types)
    ? obj.types.filter(
        (t): t is TypeFilter =>
          typeof t === "string" &&
          (ISSUE_TYPE_FILTERS as readonly string[]).includes(t),
      )
    : [];
  const readiness =
    typeof obj.readiness === "string" &&
    (READINESS_ORDER as readonly string[]).includes(obj.readiness)
      ? (obj.readiness as ReadinessBucket)
      : null;
  return { types: [...new Set(types)], readiness };
}

export function hasActiveFilters(filters: MatrixFilters): boolean {
  return filters.types.length > 0 || filters.readiness != null;
}

type Filterable = { issue_type: string | null; readiness_score: number | null };

export function matchesFilters(item: Filterable, filters: MatrixFilters): boolean {
  if (filters.types.length) {
    const t = item.issue_type ?? "unclassified";
    if (!(filters.types as readonly string[]).includes(t)) return false;
  }
  if (filters.readiness) {
    const s = item.readiness_score;
    if (filters.readiness === "unscored") return s == null;
    if (s == null) return false;
    if (filters.readiness === "ready") return s >= 80;
    if (filters.readiness === "almost") return s >= 50 && s < 80;
    return s < 50; // needswork
  }
  return true;
}

export function applyFilters<T extends Filterable>(
  items: T[],
  filters: MatrixFilters,
): T[] {
  return items.filter((item) => matchesFilters(item, filters));
}

/** Human-readable summary, e.g. "Bug, Debt · Ready (≥80)". */
export function filterSummary(filters: MatrixFilters): string {
  const parts: string[] = [];
  if (filters.types.length) {
    parts.push(filters.types.map((t) => TYPE_LABEL[t]).join(", "));
  }
  if (filters.readiness) {
    parts.push(READINESS_BUCKETS[filters.readiness].label);
  }
  return parts.length ? parts.join(" · ") : "All issues";
}
