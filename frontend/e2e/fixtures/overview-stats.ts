import type { OverviewStats } from "../../src/components/overview/types";

const dayIso = (offset: number) =>
  new Date(Date.now() - offset * 86_400_000).toISOString().slice(0, 10);
const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();

export const fullStats: OverviewStats = {
  connected_repos: 2,
  open_issues: 128,
  last_synced_at: hoursAgo(0.05),
  top_repos: [
    { id: 500, full_name: "patelmj/mehova", open_issues_count: 80 },
    { id: 501, full_name: "patelmj/IssueLens", open_issues_count: 48 },
  ],
  activity: Array.from({ length: 30 }, (_, idx) => ({
    date: dayIso(29 - idx),
    opened: (idx * 7) % 5,
    closed: (idx * 3) % 4,
  })),
  do_first: [
    {
      issue_id: 9001, number: 101, title: "Auth token crash", repo_short: "mehova",
      issue_type: "bug", estimate: 4, readiness: 55, score: 150, opened_at: hoursAgo(72),
    },
    {
      issue_id: 9002, number: 102, title: "Bulk-close flow", repo_short: "IssueLens",
      issue_type: "feature", estimate: 2, readiness: 80, score: 145, opened_at: hoursAgo(48),
    },
    {
      issue_id: 9003, number: 103, title: "Flaky sync retries", repo_short: "mehova",
      issue_type: null, estimate: 3, readiness: null, score: 133, opened_at: hoursAgo(192),
    },
  ],
  minimap: [
    { u: 80, i: 70, type: "bug", estimate: 4 },
    { u: 90, i: 40, type: "feature", estimate: 2 },
    { u: 60.5, i: 72.5, type: null, estimate: 3 },
    { u: 20, i: 85, type: "debt", estimate: 1 },
  ],
  triage: { count: 7, top: [{ readiness: 22 }, { readiness: 35 }, { readiness: 41 }] },
  sync: { status: "healthy", last_synced_at: hoursAgo(0.05), visible_repos: 2 },
  open_trend: Array.from({ length: 30 }, (_, idx) => 100 + idx),
  closed_week: { count: 14, delta: 3 },
  median_age_days: 9.4,
  stale_count: 5,
  events: [
    { kind: "opened", text: "#101 Auth token crash", at: hoursAgo(1) },
    { kind: "synced", text: "Synced patelmj/mehova", at: hoursAgo(2) },
    { kind: "closed", text: "#88 Fix login redirect", at: hoursAgo(3) },
  ],
};

export const emptyStats: OverviewStats = {
  connected_repos: 0,
  open_issues: 0,
  last_synced_at: null,
  top_repos: [],
  activity: [],
  do_first: [],
  minimap: [],
  triage: { count: 0, top: [] },
  sync: { status: "healthy", last_synced_at: null, visible_repos: 0 },
  open_trend: Array.from({ length: 30 }, () => 0),
  closed_week: { count: 0, delta: 0 },
  median_age_days: null,
  stale_count: 0,
  events: [],
};
