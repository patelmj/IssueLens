"use client";

import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useRouter, useSearchParams } from "next/navigation";
import { Fragment, useCallback, useState } from "react";
import { getJson } from "../../lib/api";
import { SuggestionDrawer } from "./suggestion-drawer";
import { TriageToolbar } from "./triage-toolbar";

export type MissingItem = { id: string; label: string };

export type InboxItem = {
  id: number;
  number: number;
  title: string;
  repo_full_name: string;
  issue_type: string;
  component: string | null;
  readiness_score: number;
  missing: MissingItem[];
  suggestion_status: string | null;
};

type InboxPage = {
  items: InboxItem[];
  total: number;
  limit: number;
  offset: number;
};

const LIMIT = 50;
const card =
  "rounded-[14px] border border-(--color-border) bg-(--color-surface) shadow-(--shadow-card)";
const chip =
  "rounded-full border border-(--type-bug) px-1.5 text-[10px] text-(--type-bug)";
const btn =
  "rounded-lg border border-(--color-border) bg-(--color-surface) px-2.5 py-1.5 text-(--color-primary) transition-all duration-150 hover:bg-(--accent-tint)";

function readinessTone(score: number): string {
  if (score < 40) return "text-(--type-bug)";
  if (score < 75) return "text-(--type-debt)";
  return "text-(--type-feature)";
}

const STATUS_BADGE: Record<string, string> = {
  draft: "text-(--color-text-muted)",
  suggested: "text-(--type-feature)",
  pushed: "text-(--type-feature)",
  rejected: "text-(--color-text-muted)",
};

export function TriageClient() {
  const searchParams = useSearchParams();
  const router = useRouter();

  const setParams = useCallback(
    (updates: Record<string, string | null>) => {
      const next = new URLSearchParams(searchParams.toString());
      for (const [key, value] of Object.entries(updates)) {
        if (value === null || value === "") next.delete(key);
        else next.set(key, value);
      }
      const qs = next.toString();
      router.replace(qs ? `/triage?${qs}` : "/triage", { scroll: false });
    },
    [router, searchParams],
  );

  const repoId = searchParams.get("repo_id");
  const type = searchParams.get("type");
  const threshold = searchParams.get("threshold") ?? "80";
  const offset = Math.max(0, Number(searchParams.get("offset") ?? "0") || 0);

  const backendQuery = new URLSearchParams({
    threshold,
    limit: String(LIMIT),
    offset: String(offset),
  });
  if (repoId) backendQuery.set("repo_id", repoId);
  if (type) backendQuery.set("type", type);

  const { data, error, isPending } = useQuery({
    queryKey: ["triage-inbox", backendQuery.toString()],
    queryFn: () => getJson<InboxPage>(`/api/backend/triage/inbox?${backendQuery}`),
    placeholderData: keepPreviousData,
  });

  const [expandedId, setExpandedId] = useState<number | null>(null);

  return (
    <div className="flex flex-col gap-4" data-testid="triage-content">
      <div className="flex items-baseline gap-3">
        <h1 className="text-lg font-semibold tracking-[-0.01em]">Triage</h1>
        <span className="text-(--color-text-muted)">
          Issues that need detail before work can start
        </span>
      </div>

      <TriageToolbar params={{ repoId, type, threshold, setParams }} />

      {isPending ? (
        <div className={`${card} px-6 py-16 text-center text-(--color-text-muted)`}>
          Loading triage inbox…
        </div>
      ) : error ? (
        <div className={`${card} px-6 py-16 text-center`}>
          <div className="text-sm font-medium">Backend unavailable</div>
          <div className="pt-1.5 text-(--color-text-muted)">{error.message}</div>
        </div>
      ) : !data || data.total === 0 ? (
        <div className={`${card} flex flex-col items-center gap-1.5 px-6 py-16 text-center`}>
          <div className="text-sm font-medium">Nothing needs detail</div>
          <div className="max-w-md text-(--color-text-muted)">
            Every scored issue is above the readiness threshold. Lower the threshold
            to review more.
          </div>
        </div>
      ) : (
        <div className={`${card} divide-y divide-(--color-border)`}>
          {data.items.map((item) => (
            <Fragment key={item.id}>
              <div className="flex flex-col gap-1.5 px-4 py-3" data-testid="triage-row">
                <div className="flex items-center gap-3">
                  <span
                    className={`tabular-nums text-sm font-semibold ${readinessTone(item.readiness_score)}`}
                  >
                    {item.readiness_score}%
                  </span>
                  <span className="font-medium">
                    #{item.number} {item.title}
                  </span>
                  <span className="text-[11px] text-(--color-text-muted) uppercase">
                    {item.issue_type}
                    {item.component ? ` · ${item.component}` : ""}
                  </span>
                  {item.suggestion_status ? (
                    <span
                      className={`text-[11px] ${STATUS_BADGE[item.suggestion_status] ?? ""}`}
                      data-testid="row-status"
                    >
                      {item.suggestion_status}
                    </span>
                  ) : null}
                </div>
                {item.missing.length > 0 ? (
                  <div
                    className="flex flex-wrap items-center gap-1.5"
                    data-testid="missing-chips"
                  >
                    <span className="text-[11px] text-(--color-text-muted)">Missing:</span>
                    {item.missing.map((m) => (
                      <span key={m.id} className={chip}>
                        {m.label}
                      </span>
                    ))}
                  </div>
                ) : null}
                <div className="flex items-center gap-2 pt-1">
                  <button
                    type="button"
                    className={btn}
                    onClick={() =>
                      setExpandedId(expandedId === item.id ? null : item.id)
                    }
                    aria-expanded={expandedId === item.id}
                  >
                    {item.suggestion_status ? "View suggestion" : "Suggest fixes"}
                  </button>
                  <a
                    className={btn}
                    href={`https://github.com/${item.repo_full_name}/issues/${item.number}`}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    Open in GitHub
                  </a>
                </div>
              </div>
              {expandedId === item.id ? (
                <div className="bg-(--accent-tint) px-4 py-3">
                  <SuggestionDrawer
                    issueId={item.id}
                    hasExisting={item.suggestion_status !== null}
                    onClose={() => setExpandedId(null)}
                  />
                </div>
              ) : null}
            </Fragment>
          ))}
        </div>
      )}
    </div>
  );
}
