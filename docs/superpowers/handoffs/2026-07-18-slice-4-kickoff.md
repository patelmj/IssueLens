# Handoff: Slice #4 kickoff (live Overview + issues table)

**Written:** 2026-07-18, end of the session that shipped slices #1–#3.

## Where the project stands

- **main** (`8ac23c8`) has three merged slices, all CI-green:
  1. Foundation — full Docker stack (Next.js :3005, FastAPI :8000, Postgres+pgvector, Redis, ARQ worker), dark-first token theme, app shell with six routes, Playwright smoke, CI.
  2. GitHub sync — GitHub App auth (polling, no webhooks yet), migration 0002 (installations/repositories/issues/sync_jobs), idempotent sync + 30-min reconciliation cron, `/repositories` API + live page.
- **Live and dogfooded:** the user's GitHub App (`issuelens-local`) is installed; 32 repos discovered; `patelmj/mehova` (159 issues / 80 open) and `patelmj/IssueLens` (16 / 14) synced into Postgres. Credentials live in git-ignored repo-root `.env` (compose forwards them — do not re-debug this; it works).
- **Board:** issues #1–#3 Done on the IssueLens Roadmap (project #3). **Next: issue #4 (spreadsheet issues table, P1)**.

## What slice #4 is (agreed with the user)

The user flagged that Overview/Analyze look dead despite 175 synced issues — the empty
states are foundation placeholders and Overview's copy ("Connect a repository to begin")
is now factually wrong. Agreed plan, **in this order**:

1. **Live Overview first** — real stat tiles from synced data (connected repos, open
   issues, recently synced, biggest repos). Small, kills the "is it on?" feeling.
   Load the `dataviz` skill before building any tiles/charts.
2. **Spreadsheet issues table** — spec §7 (+ §7.1 columns, §7.2 actions): the sortable/
   filterable table over the `issues` table. This is the workhorse surface for later slices.

Analytics proper stays at board #15 (needs scoring history that doesn't exist yet).

## How to run this project's workflow

- Process: superpowers brainstorming → spec (docs/superpowers/specs/) → writing-plans
  (docs/superpowers/plans/, complete code in every step) → **subagent-driven development
  always** (user preference; haiku for transcription tasks, sonnet for integration +
  every review, top tier for the final whole-branch review). Ledger at
  `.superpowers/sdd/progress.md` — read it before dispatching anything.
- House rules live in `CLAUDE.md` (tokens-only colors with `bg-(--token)` syntax, docs
  pushed to GitHub before review requests, no AI attribution in commits, pause before
  PR/merge). Design direction: `.claude/skills/sketch-findings-issuelens/`.
- User pattern so far: direct merges without PRs, after live verification.

## Deferred-findings intake for slice #4 (from the ledger — do these in this slice)

- FK indexes on `repositories.installation_id` and `sync_jobs.repository_id` (fold into
  this slice's migration if one is added)
- `_job_id=f"sync-repo-{repo_id}"` on sync enqueue (ARQ dedup of concurrent syncs)
- Missing tests: 503-unconfigured on the sync endpoint; `since` param actually sent on
  second sync; e2e assertion of the "Connect GitHub" empty state
- Overview's stale "Connect a repository to begin" copy (superseded by the live Overview)

Deferred to LATER slices (do not pull in): endpoint auth + `sync_error` sanitization +
token-cache 401 invalidation (auth slice, before any non-loopback bind); webhooks/smee;
healthz redis check; `GitHubRateLimited` → 429 mapping.

## Gotchas that cost time before (don't rediscover)

- Compose does NOT inject `.env` into containers — vars must be forwarded in
  `docker-compose.yml` `environment:` blocks (already done for the GitHub pair).
- respx: a query-less route pattern matches ANY query string on that path — register
  more-specific routes first or tests hang.
- arq cron names default to `cron:<fn>` — pass `name=` explicitly.
- The REST issues list includes PRs — `is_pull_request` is already flagged; exclude PRs
  from issue-facing views.
- Frontend port is 3005 (mehova owns 3000). Primary dev loop: `npm run dev:local`.
- Tests share the dev Postgres — test seeds can linger in the UI; `clean_db` truncates
  at test start, not end.
