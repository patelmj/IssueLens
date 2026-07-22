"use client";

import { useEffect, useRef, useState } from "react";
import {
  ISSUE_TYPE_FILTERS,
  READINESS_BUCKETS,
  READINESS_ORDER,
  TYPE_LABEL,
  hasActiveFilters,
  NO_FILTERS,
  type MatrixFilters,
  type TypeFilter,
} from "../lib/matrix-filters";

const chipBase = "rounded-lg border px-2.5 py-1.5 transition-all duration-150";
const chipIdle =
  "border-(--color-border) bg-(--color-surface) text-(--color-text-muted) hover:text-(--color-text)";
const chipActive = "border-transparent bg-(--accent-tint) font-medium text-(--color-primary)";
const panel =
  "absolute left-0 top-full z-30 mt-1 flex min-w-44 flex-col gap-0.5 rounded-lg border border-(--color-border) bg-(--color-surface) p-1.5 shadow-(--shadow-card)";

export function FilterChips({
  filters,
  onChange,
}: {
  filters: MatrixFilters;
  onChange: (next: MatrixFilters) => void;
}) {
  const [openPanel, setOpenPanel] = useState<"type" | "readiness" | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  // Local mirror of `filters.types` for instant checkbox feedback. `onChange`
  // routes through the URL (router.replace), which resolves a tick after the
  // click — a controlled checkbox bound directly to the prop would flash back
  // to unchecked in that window. Reconciled during render (not an effect) once
  // the prop's value — not just its reference, which is fresh every render —
  // actually changes.
  const typesKey = filters.types.join(",");
  const [localTypes, setLocalTypes] = useState(filters.types);
  const [syncedKey, setSyncedKey] = useState(typesKey);
  if (typesKey !== syncedKey) {
    setSyncedKey(typesKey);
    setLocalTypes(filters.types);
  }

  // Same optimistic-mirror pattern for the readiness bucket, so both chips
  // read local state and every onChange payload is built from locals —
  // otherwise a click in one panel landing before the other panel's
  // router.replace resolves would spread stale URL state over it.
  const [localReadiness, setLocalReadiness] = useState(filters.readiness);
  const [syncedReadiness, setSyncedReadiness] = useState(filters.readiness);
  if (filters.readiness !== syncedReadiness) {
    setSyncedReadiness(filters.readiness);
    setLocalReadiness(filters.readiness);
  }

  useEffect(() => {
    if (!openPanel) return;
    const onPointerDown = (e: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpenPanel(null);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpenPanel(null);
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [openPanel]);

  const toggleType = (t: TypeFilter) => {
    const has = localTypes.includes(t);
    const nextTypes = has ? localTypes.filter((x) => x !== t) : [...localTypes, t];
    setLocalTypes(nextTypes);
    onChange({ types: nextTypes, readiness: localReadiness });
  };

  const typeLabel =
    localTypes.length === 0
      ? "Type: All"
      : `Type: ${localTypes.map((t) => TYPE_LABEL[t]).join(", ")}`;
  const readinessLabel = localReadiness
    ? `Readiness: ${READINESS_BUCKETS[localReadiness].label}`
    : "Readiness: Any";

  return (
    <div ref={rootRef} className="flex items-center gap-2">
      <div className="relative">
        <button
          type="button"
          data-testid="type-chip"
          aria-expanded={openPanel === "type"}
          className={`${chipBase} ${localTypes.length ? chipActive : chipIdle}`}
          onClick={() => setOpenPanel(openPanel === "type" ? null : "type")}
        >
          {typeLabel}
        </button>
        {openPanel === "type" ? (
          <div className={panel} data-testid="type-panel">
            {ISSUE_TYPE_FILTERS.map((t) => (
              <label
                key={t}
                className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1 transition-all duration-150 hover:bg-(--accent-tint)"
              >
                <input
                  type="checkbox"
                  checked={localTypes.includes(t)}
                  onChange={() => toggleType(t)}
                />
                <span>{TYPE_LABEL[t]}</span>
              </label>
            ))}
          </div>
        ) : null}
      </div>

      <div className="relative">
        <button
          type="button"
          data-testid="readiness-chip"
          aria-expanded={openPanel === "readiness"}
          className={`${chipBase} ${localReadiness ? chipActive : chipIdle}`}
          onClick={() => setOpenPanel(openPanel === "readiness" ? null : "readiness")}
        >
          {readinessLabel}
        </button>
        {openPanel === "readiness" ? (
          <div className={panel} data-testid="readiness-panel">
            <button
              type="button"
              data-testid="readiness-any"
              className={`rounded-md px-2 py-1 text-left transition-all duration-150 hover:bg-(--accent-tint) ${
                localReadiness == null ? "text-(--color-primary)" : ""
              }`}
              onClick={() => {
                setLocalReadiness(null);
                onChange({ types: localTypes, readiness: null });
                setOpenPanel(null);
              }}
            >
              Any
            </button>
            {READINESS_ORDER.map((bucket) => (
              <button
                key={bucket}
                type="button"
                data-testid={`readiness-${bucket}`}
                className={`rounded-md px-2 py-1 text-left transition-all duration-150 hover:bg-(--accent-tint) ${
                  localReadiness === bucket ? "text-(--color-primary)" : ""
                }`}
                onClick={() => {
                  setLocalReadiness(bucket);
                  onChange({ types: localTypes, readiness: bucket });
                  setOpenPanel(null);
                }}
              >
                {READINESS_BUCKETS[bucket].label}
              </button>
            ))}
          </div>
        ) : null}
      </div>

      {hasActiveFilters(filters) ? (
        <button
          type="button"
          data-testid="clear-filters"
          className="text-(--color-text-muted) transition-all duration-150 hover:text-(--color-text)"
          onClick={() => {
            setLocalTypes([]);
            setLocalReadiness(null);
            onChange(NO_FILTERS);
          }}
        >
          Clear filters
        </button>
      ) : null}
    </div>
  );
}
