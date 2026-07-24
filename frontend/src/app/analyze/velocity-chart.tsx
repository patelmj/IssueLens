"use client";

import { useState } from "react";
import { card, type CompletedAnalytics } from "./shared";
import { InfoTip, ValueTip, type TipState } from "./info-tip";

type WeekRow = CompletedAnalytics["weekly"][number];

const SERIES: { key: keyof Pick<WeekRow, "bug" | "feature" | "debt" | "other">; label: string; token: string }[] = [
  { key: "bug", label: "Bug", token: "var(--type-bug)" },
  { key: "feature", label: "Feature", token: "var(--type-feature)" },
  { key: "debt", label: "Debt", token: "var(--type-debt)" },
  { key: "other", label: "Other", token: "var(--type-task)" },
];

const H = 120;
const BAR_MAX = 96;

export function VelocityChart({ weekly }: { weekly: WeekRow[] }) {
  const [tip, setTip] = useState<TipState>(null);
  const max = Math.max(1, ...weekly.map((w) => w.bug + w.feature + w.debt + w.other));

  return (
    <div className={`${card} relative`} data-testid="velocity-chart">
      <div className="mb-2 flex items-center gap-1.5 text-[12px] font-semibold">
        Completed per week <InfoTip metric="velocity" />
      </div>
      <div className="flex items-end gap-1.5" style={{ height: H }}>
        {weekly.map((w) => {
          const total = w.bug + w.feature + w.debt + w.other;
          return (
            <div
              key={w.week_start}
              className="flex min-w-2 flex-1 flex-col-reverse gap-0.5"
              data-testid={`velocity-bar-${w.week_start}`}
              onMouseEnter={(e) => {
                const rect = e.currentTarget.parentElement!.getBoundingClientRect();
                setTip({
                  x: e.currentTarget.getBoundingClientRect().left - rect.left,
                  y: -8,
                  lines: [
                    `Week of ${w.week_start}`,
                    `${total} completed — ${SERIES.filter((s) => w[s.key] > 0)
                      .map((s) => `${w[s.key]} ${s.label.toLowerCase()}`)
                      .join(" · ") || "none"}`,
                  ],
                });
              }}
              onMouseLeave={() => setTip(null)}
            >
              {SERIES.map((s) =>
                w[s.key] > 0 ? (
                  <div
                    key={s.key}
                    className="rounded-[3px]"
                    style={{ height: Math.max(3, (w[s.key] / max) * BAR_MAX), background: s.token }}
                  />
                ) : null,
              )}
            </div>
          );
        })}
      </div>
      <div className="mt-2 flex gap-4 text-[10px] text-(--color-text-muted)">
        {SERIES.map((s) => (
          <span key={s.key} className="inline-flex items-center gap-1">
            <i className="inline-block h-2 w-2 rounded-[2px]" style={{ background: s.token }} />
            {s.label}
          </span>
        ))}
      </div>
      <ValueTip tip={tip} />
    </div>
  );
}
