"use client";

import { keepPreviousData, useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useState } from "react";
import { getJson } from "../../lib/api";
import { relativeTime } from "../../lib/time";
import { Toolbar } from "./toolbar";

export type IssueRow = {
  id: number;
  repository_id: number;
  repo_full_name: string;
  number: number;
  title: string;
  state: "open" | "closed";
  author_login: string;
  labels: { name: string; color: string }[];
  assignees: string[];
  milestone_title: string | null;
  comments_count: number;
  gh_created_at: string;
  gh_updated_at: string;
  gh_closed_at: string | null;
};

export type IssuePage = {
  items: IssueRow[];
  total: number;
  limit: number;
  offset: number;
};

export type SortKey = "updated" | "created" | "comments" | "number" | "title";

export type ColumnKey =
  | "repo"
  | "number"
  | "title"
  | "labels"
  | "assignees"
  | "comments"
  | "updated"
  | "state"
  | "milestone"
  | "author"
  | "created";

export type TableParams = {
  repoId: string | null;
  state: string;
  label: string | null;
  assignee: string | null;
  q: string | null;
  setParams: (updates: Record<string, string | null>) => void;
};

export const COLUMNS: {
  key: ColumnKey;
  label: string;
  sort?: SortKey;
  defaultVisible: boolean;
}[] = [
  { key: "repo", label: "Repo", defaultVisible: true },
  { key: "number", label: "#", sort: "number", defaultVisible: true },
  { key: "title", label: "Title", sort: "title", defaultVisible: true },
  { key: "labels", label: "Labels", defaultVisible: true },
  { key: "assignees", label: "Assignees", defaultVisible: true },
  { key: "comments", label: "Comments", sort: "comments", defaultVisible: true },
  { key: "updated", label: "Updated", sort: "updated", defaultVisible: true },
  { key: "state", label: "State", defaultVisible: true },
  { key: "milestone", label: "Milestone", defaultVisible: false },
  { key: "author", label: "Author", defaultVisible: false },
  { key: "created", label: "Created", sort: "created", defaultVisible: false },
];

const LIMIT = 50;

const card =
  "rounded-[14px] border border-(--color-border) bg-(--color-surface) shadow-(--shadow-card)";
const btn =
  "rounded-lg border border-(--color-border) bg-(--color-surface) px-2.5 py-1.5 text-(--color-primary) transition-all duration-150 hover:bg-(--accent-tint) disabled:text-(--color-text-muted) disabled:hover:bg-(--color-surface)";

function stateBadge(state: IssueRow["state"]) {
  return state === "open"
    ? "text-(--color-primary) border-(--color-primary)"
    : "text-(--color-text-muted) border-(--color-border)";
}

export function PlanClient() {
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
      router.replace(qs ? `/plan?${qs}` : "/plan", { scroll: false });
    },
    [router, searchParams],
  );

  const repoId = searchParams.get("repo_id");
  const state = searchParams.get("state") ?? "open";
  const label = searchParams.get("label");
  const assignee = searchParams.get("assignee");
  const q = searchParams.get("q");
  const sort = (searchParams.get("sort") ?? "updated") as SortKey;
  const order = searchParams.get("order") ?? "desc";
  const offset = Math.max(0, Number(searchParams.get("offset") ?? "0") || 0);

  const backendQuery = new URLSearchParams({
    state,
    sort,
    order,
    limit: String(LIMIT),
    offset: String(offset),
  });
  if (repoId) backendQuery.set("repo_id", repoId);
  if (label) backendQuery.set("label", label);
  if (assignee) backendQuery.set("assignee", assignee);
  if (q) backendQuery.set("q", q);

  const { data, error, isPending } = useQuery({
    queryKey: ["issues", backendQuery.toString()],
    queryFn: () => getJson<IssuePage>(`/api/backend/issues?${backendQuery}`),
    placeholderData: keepPreviousData,
  });

  const { data: repos, isPending: reposPending } = useQuery({
    queryKey: ["repositories"],
    queryFn: () =>
      getJson<{ id: number; full_name: string }[]>("/api/backend/repositories"),
  });

  const [visible, setVisible] = useState<Set<ColumnKey>>(
    () => new Set(COLUMNS.filter((c) => c.defaultVisible).map((c) => c.key)),
  );

  const onToggleColumn = (key: ColumnKey) => {
    setVisible((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const toggleSort = (key: SortKey) => {
    if (sort === key) {
      const nextOrder = order === "desc" ? "asc" : "desc";
      setParams({ order: nextOrder === "desc" ? null : nextOrder, offset: null });
    } else {
      setParams({
        sort: key === "updated" ? null : key,
        order: null,
        offset: null,
      });
    }
  };

  const shownColumns = COLUMNS.filter((c) => visible.has(c.key));

  return (
    <div className="flex flex-col gap-4" data-testid="plan-content">
      <div className="flex items-baseline gap-3">
        <h1 className="text-lg font-semibold tracking-[-0.01em]">Plan</h1>
        <span className="text-(--color-text-muted)">
          Issues across your synced repositories
        </span>
      </div>

      <Toolbar
        params={{ repoId, state, label, assignee, q, setParams }}
        visible={visible}
        onToggleColumn={onToggleColumn}
      />

      {isPending || reposPending ? (
        <div className={`${card} px-6 py-16 text-center text-(--color-text-muted)`}>
          Loading issues…
        </div>
      ) : error ? (
        <div className={`${card} px-6 py-16 text-center`}>
          <div className="text-sm font-medium">Backend unavailable</div>
          <div className="pt-1.5 text-(--color-text-muted)">{error.message}</div>
        </div>
      ) : repos && repos.length === 0 ? (
        <div className={`${card} flex flex-col items-center gap-1.5 px-6 py-16 text-center`}>
          <div className="text-sm font-medium">No repositories connected</div>
          <div className="max-w-md text-(--color-text-muted)">
            Install the IssueLens GitHub App and sync a repository to fill this
            table with real issues.
          </div>
          <Link
            className="pt-2 text-(--color-primary) hover:underline"
            href="/repositories"
          >
            Go to Repositories →
          </Link>
        </div>
      ) : !data || data.total === 0 ? (
        <div className={`${card} flex flex-col items-center gap-1.5 px-6 py-16 text-center`}>
          <div className="text-sm font-medium">No issues match these filters</div>
          <div className="max-w-md text-(--color-text-muted)">
            Adjust the filters above, or clear them to see every open issue.
          </div>
          <button
            type="button"
            className={`${btn} mt-2`}
            onClick={() => router.replace("/plan")}
          >
            Clear filters
          </button>
        </div>
      ) : (
        <>
          <div className={`${card} overflow-x-auto`}>
            <table className="w-full text-left">
              <thead>
                <tr className="border-b border-(--color-border)">
                  {shownColumns.map((col) => (
                    <th key={col.key} className="px-3 py-2 font-medium">
                      {col.sort ? (
                        <button
                          type="button"
                          onClick={() => toggleSort(col.sort!)}
                          className={`flex items-center gap-1 transition-all duration-150 hover:text-(--color-primary) ${
                            sort === col.sort
                              ? "text-(--color-primary)"
                              : "text-(--color-text)"
                          }`}
                        >
                          {col.label}
                          <span
                            aria-hidden
                            className={
                              sort === col.sort ? "" : "text-(--color-text-muted)"
                            }
                          >
                            {sort === col.sort && order === "asc" ? "▲" : "▼"}
                          </span>
                        </button>
                      ) : (
                        col.label
                      )}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {data.items.map((row) => (
                  <tr
                    key={row.id}
                    className="border-b border-(--color-border) last:border-b-0"
                  >
                    {visible.has("repo") ? (
                      <td className="px-3 py-2 whitespace-nowrap text-(--color-text-muted)">
                        {row.repo_full_name.split("/")[1]}
                      </td>
                    ) : null}
                    {visible.has("number") ? (
                      <td className="px-3 py-2 text-(--color-text-muted)">
                        #{row.number}
                      </td>
                    ) : null}
                    {visible.has("title") ? (
                      <td className="max-w-md px-3 py-2">
                        <a
                          href={`https://github.com/${row.repo_full_name}/issues/${row.number}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="block truncate font-medium hover:text-(--color-primary)"
                          title={row.title}
                        >
                          {row.title}
                        </a>
                      </td>
                    ) : null}
                    {visible.has("labels") ? (
                      <td className="px-3 py-2">
                        <span className="flex flex-wrap gap-1">
                          {row.labels.slice(0, 3).map((lb) => (
                            <span
                              key={lb.name}
                              className="flex items-center gap-1 rounded-full border border-(--color-border) px-1.5 text-[10px]"
                            >
                              <span
                                className="inline-block h-1.5 w-1.5 rounded-full"
                                style={{ background: `#${lb.color || "999999"}` }}
                              />
                              {lb.name}
                            </span>
                          ))}
                          {row.labels.length > 3 ? (
                            <span className="text-[10px] text-(--color-text-muted)">
                              +{row.labels.length - 3}
                            </span>
                          ) : null}
                        </span>
                      </td>
                    ) : null}
                    {visible.has("assignees") ? (
                      <td className="px-3 py-2 whitespace-nowrap text-(--color-text-muted)">
                        {row.assignees.join(", ") || "—"}
                      </td>
                    ) : null}
                    {visible.has("comments") ? (
                      <td className="px-3 py-2 text-(--color-text-muted)">
                        {row.comments_count}
                      </td>
                    ) : null}
                    {visible.has("updated") ? (
                      <td className="px-3 py-2 whitespace-nowrap text-(--color-text-muted)">
                        {relativeTime(row.gh_updated_at)}
                      </td>
                    ) : null}
                    {visible.has("state") ? (
                      <td className="px-3 py-2">
                        <span
                          className={`rounded-full border px-1.5 text-[10px] ${stateBadge(row.state)}`}
                        >
                          {row.state}
                        </span>
                      </td>
                    ) : null}
                    {visible.has("milestone") ? (
                      <td className="px-3 py-2 whitespace-nowrap text-(--color-text-muted)">
                        {row.milestone_title ?? "—"}
                      </td>
                    ) : null}
                    {visible.has("author") ? (
                      <td className="px-3 py-2 whitespace-nowrap text-(--color-text-muted)">
                        {row.author_login}
                      </td>
                    ) : null}
                    {visible.has("created") ? (
                      <td className="px-3 py-2 whitespace-nowrap text-(--color-text-muted)">
                        {relativeTime(row.gh_created_at)}
                      </td>
                    ) : null}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="flex items-center gap-3">
            <span className="text-(--color-text-muted)">
              {data.offset + 1}–{Math.min(data.offset + data.limit, data.total)} of{" "}
              {data.total}
            </span>
            <div className="grow" />
            <button
              type="button"
              className={btn}
              disabled={data.offset === 0}
              onClick={() => {
                const prev = data.offset - LIMIT;
                setParams({ offset: prev > 0 ? String(prev) : null });
              }}
            >
              ← Prev
            </button>
            <button
              type="button"
              className={btn}
              disabled={data.offset + data.limit >= data.total}
              onClick={() => setParams({ offset: String(data.offset + LIMIT) })}
            >
              Next →
            </button>
          </div>
        </>
      )}
    </div>
  );
}
