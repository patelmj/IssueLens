import type { ActivityDay } from "../activity-chart";

export type TopRepo = { id: number; full_name: string; open_issues_count: number };

export type DoFirstItem = {
  issue_id: number;
  number: number;
  title: string;
  repo_short: string;
  issue_type: string | null;
  estimate: number;
  readiness: number | null;
  score: number;
  opened_at: string;
};

export type MinimapPoint = {
  u: number;
  i: number;
  type: string | null;
  estimate: number;
};

export type TriageTeaser = { count: number; top: { readiness: number }[] };

export type SyncHealth = {
  status: "healthy" | "syncing" | "error";
  last_synced_at: string | null;
  visible_repos: number;
};

export type ClosedWeek = { count: number; delta: number };

export type OverviewEvent = {
  kind: "opened" | "closed" | "synced";
  text: string;
  at: string;
};

export type OverviewStats = {
  connected_repos: number;
  open_issues: number;
  last_synced_at: string | null;
  top_repos: TopRepo[];
  activity: ActivityDay[];
  do_first: DoFirstItem[];
  minimap: MinimapPoint[];
  triage: TriageTeaser;
  sync: SyncHealth;
  open_trend: number[];
  closed_week: ClosedWeek;
  median_age_days: number | null;
  stale_count: number;
  events: OverviewEvent[];
};
