"use client";

import { useQuery } from "@tanstack/react-query";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { getJson } from "../lib/api";
import { relativeTime } from "../lib/time";

type ReadinessFactor = {
  requirement: string;
  points: number;
  present: boolean;
  evidence: string | null;
};

type PriorityFactor = {
  axis: "urgency" | "importance";
  sign: "+" | "-";
  text: string;
  source: "signal" | "llm";
  weight: number;
};

type IssueDetail = {
  id: number;
  repository_id: number;
  repo_full_name: string;
  html_url: string;
  number: number;
  title: string;
  body: string | null;
  state: string;
  author_login: string;
  labels: { name: string; color: string }[];
  assignees: string[];
  milestone_title: string | null;
  comments_count: number;
  gh_created_at: string;
  gh_updated_at: string;
  gh_closed_at: string | null;
  classification: {
    issue_type: string;
    component: string | null;
    confidence: number;
  } | null;
  priority: {
    urgency: number;
    importance: number;
    factors: PriorityFactor[];
  } | null;
  readiness: {
    score: number;
    issue_type: string;
    factors: ReadinessFactor[];
  } | null;
};

const btn =
  "rounded-lg border border-(--color-border) bg-(--color-surface) px-2.5 py-1 text-(--color-primary) transition-all duration-150 hover:bg-(--accent-tint)";

const sectionLabel =
  "text-[10px] font-semibold tracking-[0.08em] text-(--color-text-muted) uppercase";

/* GitHub bodies render with the app's tokens; raw HTML is ignored (react-markdown
   default) and images become links so the narrow rail never loads remote media. */
const MD_COMPONENTS: Components = {
  h1: ({ children }) => <h4 className="pt-1 text-sm font-semibold">{children}</h4>,
  h2: ({ children }) => <h4 className="pt-1 text-sm font-semibold">{children}</h4>,
  h3: ({ children }) => <h4 className="pt-1 font-semibold">{children}</h4>,
  p: ({ children }) => <p className="leading-relaxed">{children}</p>,
  ul: ({ children }) => <ul className="list-disc pl-4">{children}</ul>,
  ol: ({ children }) => <ol className="list-decimal pl-4">{children}</ol>,
  li: ({ children }) => <li className="pb-0.5">{children}</li>,
  a: ({ href, children }) => (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="text-(--color-primary) hover:underline"
    >
      {children}
    </a>
  ),
  code: ({ children }) => (
    <code className="rounded bg-(--color-bg) px-1 py-0.5 font-mono text-[11px]">
      {children}
    </code>
  ),
  pre: ({ children }) => (
    <pre className="overflow-x-auto rounded-lg border border-(--color-border) bg-(--color-bg) p-2 font-mono text-[11px]">
      {children}
    </pre>
  ),
  blockquote: ({ children }) => (
    <blockquote className="border-l-2 border-(--color-border) pl-2 text-(--color-text-muted)">
      {children}
    </blockquote>
  ),
  table: ({ children }) => (
    <div className="overflow-x-auto">
      <table className="border-collapse text-[11px]">{children}</table>
    </div>
  ),
  th: ({ children }) => (
    <th className="border border-(--color-border) px-1.5 py-0.5 text-left font-semibold">
      {children}
    </th>
  ),
  td: ({ children }) => (
    <td className="border border-(--color-border) px-1.5 py-0.5">{children}</td>
  ),
  img: ({ src, alt }) => (
    <a
      href={typeof src === "string" ? src : undefined}
      target="_blank"
      rel="noreferrer"
      className="text-(--color-primary) hover:underline"
    >
      {alt || "image"} ↗
    </a>
  ),
};

export function IssueDetailPanel({
  issueId,
  onBack,
}: {
  issueId: number;
  onBack: () => void;
}) {
  const { data, error, isPending, refetch } = useQuery({
    queryKey: ["issue-detail", issueId],
    queryFn: () => getJson<IssueDetail>(`/api/backend/issues/${issueId}`),
    retry: false,
  });

  const missing = data?.readiness?.factors.filter((f) => !f.present) ?? [];

  return (
    <div
      className="flex max-h-[calc(100vh-120px)] flex-col gap-3 overflow-y-auto rounded-[14px] border border-(--color-border) bg-(--color-surface) p-4 shadow-(--shadow-card)"
      data-testid="issue-detail-panel"
    >
      <div className="flex items-center gap-2">
        <button type="button" data-testid="detail-back" className={btn} onClick={onBack}>
          ← Queue
        </button>
        <span className="min-w-0 truncate text-(--color-text-muted)">
          {data?.repo_full_name ?? ""}
        </span>
      </div>

      {isPending ? (
        <div className="text-(--color-text-muted)">Loading issue…</div>
      ) : error ? (
        <div className="flex flex-col items-start gap-2">
          <span className="text-(--color-danger)">
            Could not load the issue: {error.message}
          </span>
          <button type="button" className={btn} onClick={() => refetch()}>
            Retry
          </button>
        </div>
      ) : (
        <>
          <div className="text-(--color-text-muted)">
            #{data.number} · {data.state} · @{data.author_login} · opened{" "}
            {relativeTime(data.gh_created_at)}
            {data.comments_count > 0 ? ` · ${data.comments_count} comments` : ""}
            {data.milestone_title ? ` · ${data.milestone_title}` : ""}
          </div>
          <h2 className="text-sm font-semibold">{data.title}</h2>

          {data.labels.length > 0 || data.assignees.length > 0 ? (
            <div className="flex flex-wrap items-center gap-1.5">
              {data.labels.map((label) => (
                <span
                  key={label.name}
                  className="flex items-center gap-1 rounded-full border border-(--color-border) px-1.5 py-0.5 text-[10px]"
                >
                  <span
                    className="inline-block h-2 w-2 rounded-full"
                    style={{
                      background: label.color
                        ? `#${label.color}`
                        : "var(--color-text-muted)",
                    }}
                  />
                  {label.name}
                </span>
              ))}
              {data.assignees.map((login) => (
                <span
                  key={login}
                  className="rounded-full border border-(--color-border) px-1.5 py-0.5 text-[10px] text-(--color-text-muted)"
                >
                  @{login}
                </span>
              ))}
            </div>
          ) : null}

          <div className="flex flex-col gap-2" data-testid="detail-body">
            {data.body ? (
              <ReactMarkdown remarkPlugins={[remarkGfm]} components={MD_COMPONENTS}>
                {data.body}
              </ReactMarkdown>
            ) : (
              <span className="text-(--color-text-muted)">
                No description provided.
              </span>
            )}
          </div>

          {data.readiness ? (
            <div className="flex flex-col gap-1.5" data-testid="detail-readiness">
              <div className="flex items-center justify-between">
                <span className={sectionLabel}>Readiness</span>
                <span className="tabular-nums">{data.readiness.score}/100</span>
              </div>
              <div className="h-1.5 overflow-hidden rounded-full border border-(--color-border) bg-(--color-bg)">
                <div
                  className="h-full rounded-full bg-(--color-primary)"
                  style={{ width: `${data.readiness.score}%` }}
                />
              </div>
              {missing.length > 0 ? (
                <ul className="flex flex-col gap-0.5">
                  {missing.map((f) => (
                    <li key={f.requirement} className="text-(--type-bug)">
                      − {f.requirement}
                    </li>
                  ))}
                </ul>
              ) : (
                <span className="text-(--color-text-muted)">Everything covered</span>
              )}
            </div>
          ) : null}

          {data.classification ? (
            <div className="text-(--color-text-muted)" data-testid="detail-classification">
              Classified {data.classification.issue_type}
              {data.classification.component
                ? ` · ${data.classification.component}`
                : ""}{" "}
              · {Math.round(data.classification.confidence * 100)}% confidence
            </div>
          ) : null}

          {data.priority ? (
            <div className="flex flex-col gap-1" data-testid="detail-priority">
              <div className="flex items-center justify-between">
                <span className={sectionLabel}>Priority factors</span>
                <span className="tabular-nums text-(--color-text-muted)">
                  U {Math.round(data.priority.urgency)} · I{" "}
                  {Math.round(data.priority.importance)}
                </span>
              </div>
              <ul className="flex flex-col gap-0.5">
                {data.priority.factors.map((f) => (
                  <li
                    key={`${f.axis}-${f.text}`}
                    className={
                      f.sign === "+" ? "text-(--type-feature)" : "text-(--type-bug)"
                    }
                  >
                    {f.sign} {f.text}
                    <span className="text-(--color-text-muted)"> · {f.axis}</span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          <a
            href={data.html_url}
            target="_blank"
            rel="noreferrer"
            data-testid="detail-github-link"
            className="mt-1 text-(--color-primary) hover:underline"
          >
            Open on GitHub ↗
          </a>
        </>
      )}
    </div>
  );
}