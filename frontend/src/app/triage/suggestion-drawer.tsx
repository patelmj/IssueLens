"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
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

  const [saved, setSaved] = useState(false);
  const savedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // triage-client hands us a fresh onClose every render; hold it in a ref so the
  // Escape listener below subscribes once instead of on every re-render.
  const onCloseRef = useRef(onClose);
  useLayoutEffect(() => {
    onCloseRef.current = onClose;
  });

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Inner dismissables (section editor, steer popover) claim Escape by
      // calling preventDefault — see the note on their handlers.
      if (e.key === "Escape" && !e.defaultPrevented) onCloseRef.current();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  useEffect(
    () => () => {
      if (savedTimer.current) clearTimeout(savedTimer.current);
    },
    [],
  );

  const confirmSaved = () => {
    setSaved(true);
    if (savedTimer.current) clearTimeout(savedTimer.current);
    savedTimer.current = setTimeout(() => setSaved(false), 2500);
  };

  const closeButton = (
    <button
      type="button"
      className="ml-auto rounded-md px-1.5 text-base leading-none text-(--color-text-muted) transition-all duration-150 hover:text-(--color-text)"
      onClick={onClose}
      aria-label="Close suggestion"
      data-testid="drawer-close"
    >
      ×
    </button>
  );

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
      // Rejecting resolves the item; saving keeps the drawer open for more
      // editing, so it needs its own confirmation instead of silence.
      if (status === "rejected") onCloseRef.current();
      else confirmSaved();
    },
  });
  const regenerateAll = useMutation({
    mutationFn: () => sendJson<Suggestion>(`${base}/${issueId}/suggestion`, "POST"),
    onSuccess: applyResult,
  });
  const push = useMutation({
    mutationFn: () =>
      sendJson<Suggestion>(`${base}/${issueId}/suggestion/push`, "POST"),
    // A pushed issue is resolved — close out and let the inbox row carry the
    // new status.
    onSuccess: (data) => {
      applyResult(data);
      onCloseRef.current();
    },
  });

  if (isPending)
    return (
      <div className="flex items-center gap-2 text-(--color-text-muted)">
        Preparing suggestion… {closeButton}
      </div>
    );
  if (error || !data)
    return (
      <div className="flex items-center gap-2 text-(--color-text-muted)">
        Could not prepare a suggestion for this issue. {closeButton}
      </div>
    );

  const actionError = (push.error ??
    regenerateAll.error ??
    setStatus.error) as Error | null;
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
        {saved ? (
          <span
            className="text-[11px] font-normal text-(--color-primary)"
            data-testid="saved-confirmation"
            role="status"
          >
            saved as suggestion
          </span>
        ) : null}
        {closeButton}
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

      {actionError ? (
        <div className="text-(--type-bug)" data-testid="drawer-error">
          {actionError.message}
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
        <button
          type="button"
          className={`${btn} ml-auto`}
          onClick={onClose}
          data-testid="drawer-done"
        >
          Done
        </button>
      </div>
    </div>
  );
}

function SectionBlock({
  issueId,
  section,
  locked,
  applyResult,
}: {
  issueId: number;
  section: Section;
  locked: boolean;
  applyResult: (data: Suggestion) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(section.body_md);
  const [steering, setSteering] = useState(false);
  const [steer, setSteer] = useState("");
  const [flash, setFlash] = useState(false);

  const patch = useMutation({
    mutationFn: (body: { body_md?: string; removed?: boolean }) =>
      sendJson<Suggestion>(
        `${base}/${issueId}/suggestion/sections/${section.requirement_id}`,
        "PATCH",
        body,
      ),
    onSuccess: (data) => {
      setEditing(false);
      applyResult(data);
    },
  });
  const regenerate = useMutation({
    mutationFn: (steerText: string | null) =>
      sendJson<Suggestion>(
        `${base}/${issueId}/suggestion/sections/${section.requirement_id}/regenerate`,
        "POST",
        { steer: steerText },
      ),
    onSuccess: (data) => {
      setSteering(false);
      setSteer("");
      setFlash(true);
      setTimeout(() => setFlash(false), 1200);
      applyResult(data);
    },
  });

  const act =
    "text-[11px] text-(--color-text-muted) transition-all duration-150 hover:text-(--color-primary)";
  // Section mutations used to fail silently — a dead Regenerate button with no
  // explanation when Ollama is unreachable.
  const sectionError = (regenerate.error ?? patch.error) as Error | null;

  return (
    <div
      className={`group mt-2 rounded-r-lg border-l-[3px] border-(--type-feature) px-3 py-2 transition-all duration-150 ${
        flash ? "bg-(--flash)" : ""
      }`}
      style={
        flash
          ? undefined
          : { background: "color-mix(in srgb, var(--type-feature) 10%, transparent)" }
      }
      data-testid={`section-block-${section.requirement_id}`}
    >
      <div className="flex items-center gap-2">
        <span className="text-[13px] font-semibold">{section.heading}</span>
        <SectionChip section={section} />
        {section.edited ? (
          <span className="text-[10px] text-(--color-text-muted)">edited</span>
        ) : null}
        {section.stale ? (
          <span className="text-[10px] text-(--color-text-muted)" data-testid={`stale-${section.requirement_id}`}>
            base changed
          </span>
        ) : null}
        {regenerate.isPending ? (
          <span className="text-[10px] text-(--color-primary)" data-testid={`section-spinner-${section.requirement_id}`}>
            redrafting…
          </span>
        ) : null}
      </div>

      {editing ? (
        <div className="mt-1 flex flex-col gap-2">
          <textarea
            aria-label={`Edit ${section.heading}`}
            className="min-h-24 rounded-lg border border-(--color-border) bg-(--color-surface) p-2 font-mono text-[12px]"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            // Escape cancels this editor rather than closing the whole drawer.
            // preventDefault is what does the work: the App Router hydrates on
            // `document`, so React's delegated listener and the drawer's own
            // Escape listener sit on the same node and stopPropagation cannot
            // reach across to a sibling listener.
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.preventDefault();
                setEditing(false);
              }
            }}
            data-testid={`section-editor-${section.requirement_id}`}
          />
          <div className="flex gap-2">
            <button type="button" className={btn} onClick={() => patch.mutate({ body_md: draft })}>
              Save section
            </button>
            <button type="button" className={btn} onClick={() => setEditing(false)}>
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <Markdown>{section.body_md}</Markdown>
      )}

      {sectionError ? (
        <div
          className="mt-1 text-[11px] text-(--type-bug)"
          data-testid={`section-error-${section.requirement_id}`}
        >
          {sectionError.message}
        </div>
      ) : null}

      {!locked && !editing ? (
        <div className="mt-1 flex gap-3 opacity-0 transition-all duration-150 group-focus-within:opacity-100 group-hover:opacity-100">
          <button
            type="button"
            className={act}
            onClick={() => regenerate.mutate(null)}
            data-testid={`regen-${section.requirement_id}`}
          >
            ↻ {section.origin === "ai" ? "Regenerate" : "Try a draft"}
          </button>
          <button
            type="button"
            className={act}
            onClick={() => setSteering((v) => !v)}
            data-testid={`steer-${section.requirement_id}`}
          >
            ✎ Steer…
          </button>
          <button
            type="button"
            className={act}
            onClick={() => {
              setDraft(section.body_md);
              setEditing(true);
            }}
            data-testid={`edit-${section.requirement_id}`}
          >
            Edit
          </button>
          <button
            type="button"
            className={`${act} hover:text-(--type-bug)`}
            onClick={() => patch.mutate({ removed: true })}
            data-testid={`remove-${section.requirement_id}`}
          >
            ✕ Remove
          </button>
        </div>
      ) : null}

      {steering ? (
        <div
          className="mt-2 flex flex-col gap-2 rounded-lg border border-(--color-border) bg-(--color-surface) p-2 shadow-md"
          // Escape dismisses the steer popover rather than the whole drawer.
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.preventDefault();
              setSteering(false);
            }
          }}
          data-testid={`steer-popover-${section.requirement_id}`}
        >
          <div className="text-[10px] font-semibold uppercase tracking-wider text-(--color-text-muted)">
            Steer this draft
          </div>
          <textarea
            aria-label={`Steer ${section.heading}`}
            className="min-h-16 rounded-lg border border-(--color-border) bg-(--color-bg) p-2 text-[12px]"
            placeholder="Add guidance for the redraft — extra details, corrections, emphasis…"
            value={steer}
            onChange={(e) => setSteer(e.target.value)}
          />
          <div className="flex gap-2">
            <button
              type="button"
              className={`${btn} text-(--color-primary)`}
              disabled={regenerate.isPending}
              onClick={() => regenerate.mutate(steer || null)}
              data-testid={`steer-submit-${section.requirement_id}`}
            >
              Redraft section
            </button>
            <button type="button" className={btn} onClick={() => setSteering(false)}>
              Cancel
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function RestoreChip({
  issueId,
  section,
  applyResult,
}: {
  issueId: number;
  section: Section;
  applyResult: (data: Suggestion) => void;
}) {
  const restore = useMutation({
    mutationFn: () =>
      sendJson<Suggestion>(
        `${base}/${issueId}/suggestion/sections/${section.requirement_id}`,
        "PATCH",
        { removed: false },
      ),
    onSuccess: applyResult,
  });
  return (
    <button
      type="button"
      className="rounded-full border border-(--color-border) px-2 py-0.5 transition-all duration-150 hover:bg-(--accent-tint)"
      onClick={() => restore.mutate()}
      data-testid={`restore-${section.requirement_id}`}
    >
      {section.heading} ↩
    </button>
  );
}
