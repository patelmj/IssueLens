"use client";

import Link from "next/link";
import type { TriageTeaser } from "./types";

export function TriageTeaserCard({ teaser }: { teaser: TriageTeaser }) {
  return (
    <Link
      href="/triage"
      data-testid="triage-teaser"
      className="block rounded-[14px] border border-(--color-border) bg-(--color-surface) px-4 py-3 shadow-(--shadow-card) transition-all hover:border-(--color-primary)"
    >
      <div className="flex items-baseline justify-between">
        <span className="text-[10px] font-semibold tracking-[0.08em] text-(--color-text-muted) uppercase">
          Triage queue
        </span>
        <span className="text-(--color-text-muted)">
          {teaser.count === 0 ? "clear" : `${teaser.count} waiting`}
        </span>
      </div>
      {teaser.count === 0 ? (
        <div className="pt-2 text-(--color-text-muted)">
          Queue clear — nothing awaiting triage.
        </div>
      ) : (
        <div className="flex flex-col gap-1.5 pt-2">
          {teaser.top.map((entry, idx) => (
            <div
              key={idx}
              data-testid="teaser-bar"
              className="h-1 overflow-hidden rounded-full bg-(--color-border)"
            >
              <div
                className="h-full rounded-full bg-(--color-primary)"
                style={{ width: `${entry.readiness}%` }}
              />
            </div>
          ))}
        </div>
      )}
    </Link>
  );
}
