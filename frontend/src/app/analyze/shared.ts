export type CompletedAnalytics = {
  totals: {
    completed: number;
    median_cycle_days: number | null;
    p90_cycle_days: number | null;
    do_first_pct: number | null;
    streak_weeks: number;
  };
  weekly: { week_start: string; bug: number; feature: number; debt: number; other: number }[];
  heatmap: { u_bin: number; i_bin: number; count: number; sample_issues: number[] }[];
  cycle_buckets: { label: string; count: number }[];
  repos: { repository_id: number; full_name: string; count: number; pct: number }[];
  streak: { weeks: { week_start: string; count: number }[]; current: number };
  recent: {
    number: number; title: string; repo: string; type: string;
    quadrant: string | null; cycle_days: number; closed_at: string;
  }[];
};

export const card =
  "rounded-[14px] border border-(--color-border) bg-(--color-surface) p-4 shadow-sm";
