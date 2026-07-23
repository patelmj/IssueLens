"use client";

import Link from "next/link";
import { radiusOf } from "../../app/plan/matrix/matrix-layout";
import { SERIES_VAR, seriesOfType } from "../../app/plan/matrix/matrix-types";
import { relativeTime } from "../../lib/time";
import type { DoFirstItem } from "./types";

export function DoFirstSpotlight({
  items,
  onOpen,
}: {
  items: DoFirstItem[];
  onOpen: (id: number) => void;
}) {
  return (
    <section
      data-testid="do-first-spotlight"
      className="rounded-[14px] border border-(--color-border) px-4 py-3 shadow-(--shadow-card)"
      style={{
        background:
          "linear-gradient(135deg, var(--quad-dofirst-strong), var(--color-surface) 55%)",
        borderLeft: "2px solid var(--quad-dofirst-label)",
      }}
    >
      <div className="flex items-baseline justify-between pb-2">
        <span
          className="text-[10px] font-semibold tracking-[0.08em] uppercase"
          style={{ color: "var(--quad-dofirst-label)" }}
        >
          Do first · from your matrix
        </span>
        <Link href="/plan/matrix" className="text-(--color-primary) hover:underline">
          View matrix →
        </Link>
      </div>
      {items.length === 0 ? (
        <div className="py-6 text-center text-(--color-text-muted)">
          Nothing in Do First —{" "}
          <Link href="/plan/matrix" className="text-(--color-primary) hover:underline">
            see Schedule
          </Link>
        </div>
      ) : (
        <ul className="flex flex-col">
          {items.map((item) => {
            const size = radiusOf(item.estimate);
            return (
              <li key={item.issue_id}>
                <button
                  type="button"
                  data-testid={`dofirst-${item.number}`}
                  onClick={() => onOpen(item.issue_id)}
                  className="flex w-full items-center gap-3 rounded-lg px-2 py-2 text-left transition-all hover:bg-(--accent-tint)"
                >
                  <span
                    aria-hidden="true"
                    className="shrink-0 rounded-full"
                    style={{
                      width: size,
                      height: size,
                      background: SERIES_VAR[seriesOfType(item.issue_type)],
                    }}
                  />
                  <span className="min-w-0 grow">
                    <span className="block truncate font-medium">{item.title}</span>
                    <span className="text-(--color-text-muted)">
                      {item.repo_short} · #{item.number} · opened {relativeTime(item.opened_at)}
                    </span>
                  </span>
                  {item.readiness != null ? (
                    <span
                      className="h-1 w-14 shrink-0 overflow-hidden rounded-full bg-(--color-border)"
                      aria-label={`Readiness ${item.readiness} of 100`}
                    >
                      <span
                        className="block h-full rounded-full bg-(--color-primary)"
                        style={{ width: `${item.readiness}%` }}
                      />
                    </span>
                  ) : null}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
