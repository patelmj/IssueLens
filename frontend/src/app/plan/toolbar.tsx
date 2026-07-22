"use client";

import { useQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import { getJson } from "../../lib/api";
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
        value={maxReadiness ?? ""}
        onChange={(e) =>
          setParams({ max_readiness: e.target.value || null, offset: null })
        }
      >
        {READINESS_THRESHOLDS.map((t) => (
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
