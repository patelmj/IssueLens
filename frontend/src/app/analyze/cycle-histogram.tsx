"use client";

import { useState } from "react";
import { card, type CompletedAnalytics } from "./shared";
import { InfoTip, ValueTip, type TipState } from "./info-tip";

export function CycleHistogram({
  buckets,
  totals,
}: {
  buckets: CompletedAnalytics["cycle_buckets"];
  totals: CompletedAnalytics["totals"];
}) {
  const [tip, setTip] = useState<TipState>(null);
  const max = Math.max(1, ...buckets.map((b) => b.count));
  return (
    <div className={`${card} relative`} data-testid="cycle-histogram">
      <div className="mb-2 flex items-center gap-1.5 text-[12px] font-semibold">
        Cycle time <InfoTip metric="cycle" />
      </div>
      <div className="flex items-end gap-1" style={{ height: 96 }}>
        {buckets.map((b) => (
          <div
            key={b.label}
            className="flex-1 rounded-t-[3px] transition-all duration-150"
            style={{
              height: b.count === 0 ? 2 : `${(b.count / max) * 100}%`,
              background: b.count === 0 ? "var(--color-border)" : "var(--viz-seq-3)",
            }}
            onMouseEnter={(e) => {
              const rect = e.currentTarget.parentElement!.getBoundingClientRect();
              setTip({
                x: e.currentTarget.getBoundingClientRect().left - rect.left,
                y: -8,
                lines: [b.label, `${b.count} completed`],
              });
            }}
            onMouseLeave={() => setTip(null)}
          />
        ))}
      </div>
      <div className="mt-1 flex justify-between text-[9px] text-(--color-text-muted)">
        {buckets.map((b) => (
          <span key={b.label}>{b.label}</span>
        ))}
      </div>
      <div className="mt-1 text-[10px] text-(--color-text-muted)">
        median {totals.median_cycle_days ?? "—"}d · p90 {totals.p90_cycle_days ?? "—"}d
      </div>
      <ValueTip tip={tip} />
    </div>
  );
}
