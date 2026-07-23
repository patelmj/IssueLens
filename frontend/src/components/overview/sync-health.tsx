"use client";

import { relativeTime } from "../../lib/time";
import type { SyncHealth } from "./types";

const STATUS_META = {
  healthy: { label: "Healthy", color: "var(--type-question)" },
  syncing: { label: "Syncing…", color: "var(--color-primary)" },
  error: { label: "Sync error", color: "var(--color-danger)" },
} as const;

export function SyncHealthCard({ sync }: { sync: SyncHealth }) {
  const meta = STATUS_META[sync.status] ?? STATUS_META.healthy;
  return (
    <div
      data-testid="sync-health"
      className="rounded-[14px] border border-(--color-border) bg-(--color-surface) px-4 py-3 shadow-(--shadow-card)"
    >
      <div className="text-[10px] font-semibold tracking-[0.08em] text-(--color-text-muted) uppercase">
        Sync
      </div>
      <div className="flex items-center gap-2 pt-1">
        <span
          aria-hidden="true"
          className="size-2 rounded-full"
          style={{ background: meta.color }}
        />
        <span className="font-medium">{meta.label}</span>
        <span className="text-(--color-text-muted)">
          · {relativeTime(sync.last_synced_at)}
        </span>
      </div>
      <div className="pt-1 text-(--color-text-muted)">
        {sync.visible_repos} repositories connected
      </div>
    </div>
  );
}
