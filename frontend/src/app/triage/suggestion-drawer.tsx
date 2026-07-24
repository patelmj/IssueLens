"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { getJson, sendJson } from "../../lib/api";

export type Section = {
  requirement_id: string;
  heading: string;
  body_md: string;
  origin: "ai" | "scaffold";
  model: string | null;
  edited: boolean;
  removed: boolean;
  stale: boolean;
};

export type Suggestion = {
  issue_id: number;
  status: string;
  base_body: string;
  proposed_body: string;
  missing_requirements: { id: string; label: string }[];
  edited: boolean;
  sections: Section[];
  drafted_at: string | null;
  pushed_at: string | null;
};

const base = "/api/backend/issues";
export const btn =
  "rounded-lg border border-(--color-border) bg-(--color-surface) px-2.5 py-1.5 transition-all duration-150 hover:bg-(--accent-tint) disabled:text-(--color-text-muted)";

function Markdown({ children }: { children: string }) {
  return (
    <div className="prose-sm max-w-none text-[13px] leading-relaxed [&_h2]:mt-3 [&_h2]:text-[13px] [&_h2]:font-semibold">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{children}</ReactMarkdown>
    </div>
  );
}

function SectionChip({ section }: { section: Section }) {
  if (section.origin === "ai") {
    return (
      <span
        className="rounded-full bg-(--accent-tint) px-2 py-0.5 text-[10px] font-semibold tracking-wide text-(--color-primary)"
        data-testid={`section-chip-${section.requirement_id}`}
      >
        AI DRAFT{section.model ? ` · ${section.model}` : ""}
      </span>
    );
  }
  return (
    <span
      className="rounded-full border border-(--color-border) px-2 py-0.5 text-[10px] font-semibold tracking-wide text-(--color-text-muted)"
      data-testid={`section-chip-${section.requirement_id}`}
    >
      EMPTY SCAFFOLD
    </span>
  );
}

export function footnotePreview(sections: Section[]): string | null {
  const ai = sections.filter((s) => !s.removed && s.origin === "ai");
  if (ai.length === 0) return null;
  const names = ai.map((s) => `"${s.heading}"`);
  const joined =
    names.length === 1
      ? names[0]
      : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
  const models = [...new Set(ai.map((s) => s.model).filter(Boolean))].join(", ");
  return `Sections ${joined} drafted by ${models} from the existing report — please confirm or correct.`;
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
  const applyResult = (data: Suggestion) => {
    qc.setQueryData(["suggestion", issueId], data);
    qc.invalidateQueries({ queryKey: ["triage-inbox"] });
  };

  const { data, error, isPending } = useQuery({
    queryKey: ["suggestion", issueId],
    queryFn: () =>
      hasExisting
        ? getJson<Suggestion>(`${base}/${issueId}/suggestion`)
        : sendJson<Suggestion>(`${base}/${issueId}/suggestion`, "POST"),
    staleTime: Infinity,
    // Poll while background drafting has not landed yet.
    refetchInterval: (query) =>
      query.state.data && query.state.data.drafted_at === null ? 3000 : false,
  });

  const setStatus = useMutation({
    mutationFn: (status: "suggested" | "rejected") =>
      sendJson<Suggestion>(`${base}/${issueId}/suggestion`, "PATCH", { status }),
    onSuccess: (data, status) => {
      applyResult(data);
      if (status === "rejected") onClose();
    },
  });
  const regenerateAll = useMutation({
    mutationFn: () => sendJson<Suggestion>(`${base}/${issueId}/suggestion`, "POST"),
    onSuccess: applyResult,
  });
  const push = useMutation({
    mutationFn: () =>
      sendJson<Suggestion>(`${base}/${issueId}/suggestion/push`, "POST"),
    onSuccess: applyResult,
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
  const visibleSections = data.sections.filter((s) => !s.removed);
  const removedSections = data.sections.filter((s) => s.removed);
  const note = footnotePreview(data.sections);

  return (
    <div className="flex flex-col gap-3" data-testid="suggestion-drawer">
      <div className="flex items-center gap-2 text-sm font-semibold">
        Proposed changes · {data.status}
        {data.edited ? " (edited)" : ""}
        {data.drafted_at === null && !locked ? (
          <span
            className="text-[11px] font-normal text-(--color-primary)"
            data-testid="drafting-indicator"
          >
            drafting answers…
          </span>
        ) : null}
      </div>

      <div
        className="grid grid-cols-1 gap-x-3 gap-y-2 min-[720px]:grid-cols-2"
        data-testid="suggestion-panes"
      >
        <div
          className="hidden rounded-lg border border-(--color-border) bg-(--color-surface) p-3 opacity-60 min-[720px]:block"
          data-testid="original-pane"
        >
          <div className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-(--color-text-muted)">
            Original
          </div>
          <Markdown>{data.base_body || "*(empty body)*"}</Markdown>
          {visibleSections.map((s) => (
            <div
              key={s.requirement_id}
              className="mt-2 rounded-md border border-dashed border-(--color-border) px-3 py-1.5 text-center text-[11px] text-(--color-text-muted)"
              data-testid={`gap-marker-${s.requirement_id}`}
            >
              no “{s.heading}” section
            </div>
          ))}
        </div>

        <div
          className="rounded-lg border border-(--color-border) bg-(--color-surface) p-3"
          data-testid="proposed-pane"
        >
          <div className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-(--color-text-muted)">
            Proposed
          </div>
          <div className="opacity-60">
            <Markdown>{data.base_body || "*(empty body)*"}</Markdown>
          </div>
          {visibleSections.map((s) => (
            <SectionBlock
              key={s.requirement_id}
              issueId={issueId}
              section={s}
              locked={locked}
              applyResult={applyResult}
            />
          ))}
          {note ? (
            <div
              className="mt-3 border-t border-(--color-border) pt-2 text-[11px] italic text-(--color-text-muted)"
              data-testid="suggestion-footnote"
            >
              {note}
            </div>
          ) : null}
        </div>
      </div>

      {removedSections.length > 0 && !locked ? (
        <div className="flex flex-wrap items-center gap-2 text-[11px] text-(--color-text-muted)">
          Removed:
          {removedSections.map((s) => (
            <RestoreChip
              key={s.requirement_id}
              issueId={issueId}
              section={s}
              applyResult={applyResult}
            />
          ))}
        </div>
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
          disabled={regenerateAll.isPending}
          onClick={() => {
            if (locked && !window.confirm("Start a new suggestion? This replaces the pushed record.")) {
              return;
            }
            regenerateAll.mutate();
          }}
        >
          Regenerate all
        </button>
      </div>
    </div>
  );
}

// Minimal read-only stubs for Task 9 (per-section edit/remove/regenerate/steer).
function SectionBlock({
  section,
}: {
  issueId: number;
  section: Section;
  locked: boolean;
  applyResult: (data: Suggestion) => void;
}) {
  return (
    <div
      className="mt-2 rounded-r-lg border-l-[3px] border-(--type-feature) bg-(--type-feature)/10 px-3 py-2"
      data-testid={`section-block-${section.requirement_id}`}
    >
      <div className="flex items-center gap-2">
        <span className="text-[13px] font-semibold">{section.heading}</span>
        <SectionChip section={section} />
        {section.stale ? (
          <span className="text-[10px] text-(--color-text-muted)">base changed</span>
        ) : null}
      </div>
      <Markdown>{section.body_md}</Markdown>
    </div>
  );
}

function RestoreChip({
  section,
}: {
  issueId: number;
  section: Section;
  applyResult: (data: Suggestion) => void;
}) {
  return <span className="rounded-full border border-(--color-border) px-2 py-0.5">{section.heading}</span>;
}
