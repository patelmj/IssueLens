"use client";

import { useQuery } from "@tanstack/react-query";
import { getJson } from "../../lib/api";

type Repo = { id: number; full_name: string };

const control =
  "rounded-lg border border-(--color-border) bg-(--color-surface) px-2 py-1.5 transition-all duration-150";

const TYPES = ["bug", "feature", "debt", "question", "docs"];

const THRESHOLDS = [
  { value: "90", label: "Readiness < 90%" },
  { value: "80", label: "Readiness < 80%" },
  { value: "60", label: "Readiness < 60%" },
  { value: "40", label: "Readiness < 40%" },
];

export type TriageParams = {
  repoId: string | null;
  type: string | null;
  threshold: string;
  setParams: (updates: Record<string, string | null>) => void;
};

export function TriageToolbar({ params }: { params: TriageParams }) {
  const { repoId, type, threshold, setParams } = params;
  const { data: repos } = useQuery({
    queryKey: ["repositories"],
    queryFn: () => getJson<Repo[]>("/api/backend/repositories"),
  });

  return (
    <div className="flex flex-wrap items-center gap-2">
      <select
        aria-label="Repository"
        className={control}
        value={repoId ?? ""}
        onChange={(e) =>
          setParams({ repo_id: e.target.value || null, offset: null })
        }
      >
        <option value="">All repositories</option>
        {(repos ?? []).map((repo) => (
          <option key={repo.id} value={String(repo.id)}>
            {repo.full_name}
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
        aria-label="Threshold"
        className={control}
        value={threshold}
        onChange={(e) => setParams({ threshold: e.target.value, offset: null })}
      >
        {THRESHOLDS.map((t) => (
          <option key={t.value} value={t.value}>
            {t.label}
          </option>
        ))}
      </select>
    </div>
  );
}
