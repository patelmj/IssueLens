"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { getJson, sendJson } from "../../lib/api";

type DiffOp = { op: "context" | "add" | "del"; line: string };
type Suggestion = {
  issue_id: number;
  status: string;
  base_body: string;
  proposed_body: string;
  missing_requirements: { id: string; label: string }[];
  edited: boolean;
  diff: DiffOp[];
  pushed_at: string | null;
};

const base = "/api/backend/issues";
const btn =
  "rounded-lg border border-(--color-border) bg-(--color-surface) px-2.5 py-1.5 transition-all duration-150 hover:bg-(--accent-tint) disabled:text-(--color-text-muted)";

function diffLineClass(op: DiffOp["op"]): string {
  if (op === "add") return "text-(--type-feature)";
  if (op === "del") return "text-(--type-bug) line-through";
  return "text-(--color-text-muted)";
}
function diffPrefix(op: DiffOp["op"]): string {
  return op === "add" ? "+ " : op === "del" ? "- " : "  ";
}

export function SuggestionDrawer({
  issueId,
  hasExisting,
  onClose,
}: {
  issueId: number;
  hasExisting: boolean;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["suggestion", issueId] });
    qc.invalidateQueries({ queryKey: ["triage-inbox"] });
  };

  // Load an existing suggestion, or generate one on first open.
  const { data, error, isPending } = useQuery({
    queryKey: ["suggestion", issueId],
    queryFn: () =>
      hasExisting
        ? getJson<Suggestion>(`${base}/${issueId}/suggestion`)
        : sendJson<Suggestion>(`${base}/${issueId}/suggestion`, "POST"),
  });

  const [draft, setDraft] = useState<string | null>(null);
  // Reset the draft when the drawer is pointed at a different issue. Adjusting
  // state during render (rather than in a useEffect) avoids an extra render pass.
  const [prevIssueId, setPrevIssueId] = useState(issueId);
  if (issueId !== prevIssueId) {
    setPrevIssueId(issueId);
    setDraft(null);
  }
  const body = draft ?? data?.proposed_body ?? "";

  const save = useMutation({
    mutationFn: (proposed_body: string) =>
      sendJson<Suggestion>(`${base}/${issueId}/suggestion`, "PATCH", { proposed_body }),
    onSuccess: () => {
      setDraft(null);
      invalidate();
    },
  });
  const setStatus = useMutation({
    mutationFn: (status: "suggested" | "rejected") =>
      sendJson<Suggestion>(`${base}/${issueId}/suggestion`, "PATCH", { status }),
    onSuccess: (_res, status) => {
      invalidate();
      if (status === "rejected") onClose();
    },
  });
  const regenerate = useMutation({
    mutationFn: () => sendJson<Suggestion>(`${base}/${issueId}/suggestion`, "POST"),
    onSuccess: () => {
      setDraft(null);
      invalidate();
    },
  });
  const push = useMutation({
    mutationFn: () =>
      sendJson<Suggestion>(`${base}/${issueId}/suggestion/push`, "POST"),
    onSuccess: invalidate,
  });

  if (isPending)
    return <div className="text-(--color-text-muted)">Preparing suggestion…</div>;
  if (error || !data)
    return (
      <div className="text-(--color-text-muted)">
        Could not prepare a suggestion for this issue.
      </div>
    );

  const pushError = push.error as Error | null;
  const locked = data.status === "pushed";

  return (
    <div className="flex flex-col gap-3" data-testid="suggestion-drawer">
      <div className="text-sm font-semibold">
        Proposed changes · {data.status}
        {data.edited ? " (edited)" : ""}
      </div>

      <pre
        className="overflow-x-auto rounded-lg border border-(--color-border) bg-(--color-surface) p-3 text-[12px] leading-relaxed"
        data-testid="suggestion-diff"
      >
        {data.diff.map((d, i) => (
          <div key={i} className={diffLineClass(d.op)}>
            {diffPrefix(d.op)}
            {d.line}
          </div>
        ))}
      </pre>

      {!locked ? (
        <textarea
          aria-label="Edit proposed body"
          className="min-h-40 rounded-lg border border-(--color-border) bg-(--color-surface) p-3 font-mono text-[12px]"
          value={body}
          onChange={(e) => setDraft(e.target.value)}
        />
      ) : null}

      {pushError ? (
        <div className="text-(--type-bug)" data-testid="push-error">
          {pushError.message}
        </div>
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          className={btn}
          disabled={locked || draft === null || save.isPending}
          onClick={() => save.mutate(body)}
        >
          Save edits
        </button>
        <button
          type="button"
          className={btn}
          disabled={locked || setStatus.isPending}
          onClick={() => setStatus.mutate("suggested")}
        >
          Save as suggestion
        </button>
        <button
          type="button"
          className={`${btn} text-(--color-primary)`}
          disabled={locked || push.isPending}
          onClick={() => push.mutate()}
          data-testid="approve-push"
        >
          Approve &amp; push
        </button>
        <button
          type="button"
          className={btn}
          disabled={locked || setStatus.isPending}
          onClick={() => setStatus.mutate("rejected")}
        >
          Reject
        </button>
        <button
          type="button"
          className={btn}
          disabled={regenerate.isPending}
          onClick={() => regenerate.mutate()}
        >
          Regenerate
        </button>
      </div>
    </div>
  );
}
