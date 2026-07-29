"use client";

import { useQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import { getJson } from "../../lib/api";
import { percentOrNull } from "../../lib/table-filters";
import { COLUMNS, type ColumnKey, type TableParams } from "./plan-client";

type Facets = {
  labels: { name: string; color: string }[];
  assignees: string[];
  components: string[];
};
type Repo = { id: number; full_name: string };

const control =
  "rounded-lg border border-(--color-border) bg-(--color-surface) px-2 py-1.5 transition-all duration-150";

const STATES = [
  { value: "open", label: "Open" },
  { value: "closed", label: "Closed" },
  { value: "all", label: "All" },
];

const TYPES = ["bug", "feature", "debt", "question", "docs"];

const READINESS_THRESHOLDS = [
  { value: "", label: "Any readiness" },
  { value: "90", label: "Readiness < 90%" },
  { value: "75", label: "Readiness < 75%" },
  { value: "50", label: "Readiness < 50%" },
  { value: "25", label: "Readiness < 25%" },
];

/**
 * A hand-typed URL like `?max_readiness=80` applies correctly server-side (see
 * plan-client.tsx) but matches none of the presets above, so the <select> would
 * otherwise render blank and silently hide an active filter (#28).
 *
 * When the current value isn't a preset, we surface it as an extra option instead
 * of snapping it to the nearest preset — snapping would misreport the filter that's
 * actually applied, which is worse than showing nothing.
 *
 * `canonical` is already sanitized by `percentOrNull` (lib/table-filters.ts): any
 * integer 0-100 inclusive, with leading zeros normalized away (e.g. "050" -> "50").
 * That normalization is what makes a hand-typed "050" collapse onto the existing "50"
 * preset instead of rendering a second, identically-labelled option. Values outside
 * 0-100, or non-numeric, arrive here as null and fall back to the prior
 * blank-on-unmatched-value behavior; it never crashes.
 */
function customReadinessOption(canonical: string | null) {
  if (canonical == null) return null;
  if (READINESS_THRESHOLDS.some((t) => t.value === canonical)) return null;
  return { value: canonical, label: `Readiness < ${canonical}%` };
}

export function Toolbar({
  params,
  visible,
  onToggleColumn,
  saveSlot,
}: {
  params: TableParams;
  visible: Set<ColumnKey>;
  onToggleColumn: (key: ColumnKey) => void;
  saveSlot?: ReactNode;
}) {
  const { repoId, state, label, assignee, q, type, component, maxReadiness, setParams } =
    params;

  const { data: repos } = useQuery({
    queryKey: ["repositories"],
    queryFn: () => getJson<Repo[]>("/api/backend/repositories"),
  });
  const { data: facets } = useQuery({
    queryKey: ["issue-facets", repoId],
    queryFn: () =>
      getJson<Facets>(
        `/api/backend/issues/facets${repoId ? `?repo_id=${repoId}` : ""}`,
      ),
  });

  // Canonicalize before comparing against presets so a leading-zero variant like
  // "050" collapses onto the "50" preset instead of rendering a duplicate option,
  // and so "0" (a genuinely valid backend filter, ge=0 in issues.py) is accepted
  // rather than dropped.
  const readinessCanonical = percentOrNull(maxReadiness ?? null);
  const customReadiness = customReadinessOption(readinessCanonical);
  const readinessOptions = customReadiness
    ? (() => {
        const numeric = Number(customReadiness.value);
        const insertAt = READINESS_THRESHOLDS.findIndex(
          (t) => t.value !== "" && Number(t.value) < numeric,
        );
        const combined = [...READINESS_THRESHOLDS];
        combined.splice(insertAt === -1 ? combined.length : insertAt, 0, customReadiness);
        return combined;
      })()
    : READINESS_THRESHOLDS;
  // The <select>'s value must match one of the option values above exactly; use the
  // canonicalized form when we have one (e.g. raw "050" -> selects the "50" option)
  // and fall back to the raw value so genuinely unrepresentable input still renders
  // blank rather than silently snapping to some option.
  const readinessSelectValue = readinessCanonical ?? (maxReadiness ?? "");

  const [searchText, setSearchText] = useState(q ?? "");
  const [prevQ, setPrevQ] = useState(q);
  if (q !== prevQ) {
    setPrevQ(q);
    setSearchText(q ?? "");
  }
  useEffect(() => {
    const timer = setTimeout(() => {
      if ((q ?? "") !== searchText) {
        setParams({ q: searchText || null, offset: null });
      }
    }, 300);
    return () => clearTimeout(timer);
  }, [searchText, q, setParams]);

  return (
    <div className="flex flex-wrap items-center gap-2">
      <select
        aria-label="Repository"
        className={control}
        value={repoId ?? ""}
        onChange={(e) =>
          setParams({
            repo_id: e.target.value || null,
            label: null,
            assignee: null,
            component: null,
            offset: null,
          })
        }
      >
        <option value="">All repositories</option>
        {(repos ?? []).map((repo) => (
          <option key={repo.id} value={String(repo.id)}>
            {repo.full_name}
          </option>
        ))}
      </select>

      <div className="flex rounded-[9px] border border-(--color-border) bg-(--color-surface) p-0.5">
        {STATES.map(({ value, label: stateLabel }) => (
          <button
            key={value}
            type="button"
            onClick={() => setParams({ state: value === "open" ? null : value, offset: null })}
            className={`rounded-[7px] px-2.5 py-1 transition-all duration-150 ${
              state === value
                ? "bg-(--accent-tint) font-medium text-(--color-primary)"
                : "text-(--color-text-muted) hover:text-(--color-text)"
            }`}
          >
            {stateLabel}
          </button>
        ))}
      </div>

      <input
        type="search"
        aria-label="Search issues"
        placeholder="Search title or #number"
        className={`${control} w-52`}
        value={searchText}
        onChange={(e) => setSearchText(e.target.value)}
      />

      <select
        aria-label="Label"
        className={control}
        value={label ?? ""}
        onChange={(e) => setParams({ label: e.target.value || null, offset: null })}
      >
        <option value="">Any label</option>
        {(facets?.labels ?? []).map((lb) => (
          <option key={lb.name} value={lb.name}>
            {lb.name}
          </option>
        ))}
      </select>

      <select
        aria-label="Assignee"
        className={control}
        value={assignee ?? ""}
        onChange={(e) =>
          setParams({ assignee: e.target.value || null, offset: null })
        }
      >
        <option value="">Any assignee</option>
        {(facets?.assignees ?? []).map((login) => (
          <option key={login} value={login}>
            {login}
          </option>
        ))}
      </select>

      <select
        aria-label="Type"
        className={control}
        value={type ?? ""}
        onChange={(e) => setParams({ type: e.target.value || null, offset: null })}
      >
        <option value="">Any type</option>
        {TYPES.map((t) => (
          <option key={t} value={t}>
            {t}
          </option>
        ))}
      </select>

      <select
        aria-label="Component"
        className={control}
        value={component ?? ""}
        onChange={(e) =>
          setParams({ component: e.target.value || null, offset: null })
        }
      >
        <option value="">Any component</option>
        {(facets?.components ?? []).map((c) => (
          <option key={c} value={c}>
            {c}
          </option>
        ))}
      </select>

      <select
        aria-label="Readiness"
        className={control}
        value={readinessSelectValue}
        onChange={(e) =>
          setParams({ max_readiness: e.target.value || null, offset: null })
        }
      >
        {readinessOptions.map((t) => (
          <option key={t.value} value={t.value}>
            {t.label}
          </option>
        ))}
      </select>

      <div className="grow" />

      {saveSlot}

      <details className="relative">
        <summary
          className={`${control} cursor-pointer list-none text-(--color-text-muted) hover:text-(--color-text)`}
        >
          Columns
        </summary>
        <div className="absolute right-0 z-10 mt-1 flex w-44 flex-col gap-1 rounded-lg border border-(--color-border) bg-(--color-surface) p-2 shadow-(--shadow-card)">
          {COLUMNS.map((col) => (
            <label key={col.key} className="flex items-center gap-2">
              <input
                type="checkbox"
                aria-label={
                  col.key === "type" || col.key === "component"
                    ? `Show ${col.label} column`
                    : undefined
                }
                checked={visible.has(col.key)}
                onChange={() => onToggleColumn(col.key)}
              />
              {col.label === "#" ? "Number" : col.label}
            </label>
          ))}
        </div>
      </details>
    </div>
  );
}
