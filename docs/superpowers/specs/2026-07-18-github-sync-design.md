# IssueLens GitHub Sync Slice — Design

**Date:** 2026-07-18
**Scope:** Board issue [#3](https://github.com/patelmj/IssueLens/issues/3) — GitHub App integration + issue sync pipeline
**Source spec:** `issuelens_github_issue_dashboard_spec.md` (§2, §17, §19, §21.1 items 1–3)
**Builds on:** foundation slice (`docs/superpowers/specs/2026-07-18-issuelens-foundation-design.md`)

## Goal

IssueLens authenticates to GitHub as a GitHub App, discovers the repositories the App is
installed on, and syncs their issues into Postgres via the ARQ worker — driven from a real
`/repositories` page. Done means: after the one-time App registration, the Repositories
page lists your repos, "Sync now" pulls open+closed issues into the `issues` table
idempotently, a cron reconciles every 30 minutes, and tests + CI are green.

## Decisions (settled during brainstorming)

| Decision | Choice | Why |
|---|---|---|
| Auth | GitHub App identity, **polling only** this slice | Spec mandates App (not PATs); webhooks + smee tunnel are a fast follow, off the critical path |
| Client | Thin in-house client: `httpx` + `PyJWT` | ~150 lines for 6 endpoints; async-native for ARQ; full control over pagination/rate handling |
| New deps (approved) | `httpx` (main), `pyjwt`, `cryptography`; dev: `respx` | Minimum for App JWT + async REST + mocked tests |
| Labels/assignees | JSONB columns on `issues` | Deliberate deviation from §19's join-table suggestion; PG filters JSONB fine for #4; normalize when something needs it (YAGNI) |
| UI scope | `/repositories` page becomes real | Slice ends with visible, browser-exercised sync; issues table stays in #4 |
| Dogfood target | `patelmj/IssueLens` (+ any repos user installs App on) | 16 real issues to sync on day one |

## 1. GitHub App setup & auth

**One-time manual step (user, ~5 min, at execution time):**
1. GitHub → Settings → Developer settings → GitHub Apps → New GitHub App
2. Name: `issuelens-local` (any unique name). Homepage URL: `http://localhost:3005`.
3. **Webhook: uncheck "Active"** (no webhook this slice).
4. Permissions: Repository → **Issues: Read-only**, **Metadata: Read-only**. Nothing else.
5. "Where can this App be installed?" → Only on this account. Create.
6. Note the **App ID**; Generate a **private key** (downloads a `.pem`).
7. Install the App on chosen repositories (at minimum `patelmj/IssueLens`).
8. In repo root `.env` (never committed):
   `ISSUELENS_GITHUB_APP_ID=<id>` and `ISSUELENS_GITHUB_APP_PRIVATE_KEY_B64=<base64 of the .pem>`
   (`.env.example` documents both with placeholder values, same commit that reads them.)

**Auth flow in code** (`backend/app/github/auth.py`): mint App JWT (RS256, 10-min exp,
PyJWT + cryptography) → `GET /app/installations` → `POST /app/installations/{id}/access_tokens`
→ cache installation token in-process until ~5 min before expiry. `backend/app/github/client.py`:
async httpx client with base `https://api.github.com`, auth header injection, Link-header
pagination helper, 403-rate-limit surfacing (raise with reset time; no retry loop this slice).

## 2. Data model — Alembic migration `0002`

- `installations`: `id` (GH installation id, PK), `account_login`, `created_at`, `updated_at`
- `repositories`: `id` (GH repo id, PK), `installation_id` FK, `full_name`, `owner`, `name`,
  `private` bool, `last_synced_at` nullable, `sync_status` enum-as-text `idle|syncing|error`
  (default `idle`), `sync_error` nullable text, `open_issues_count` int default 0
- `issues`: `id` (GH issue id, PK), `repository_id` FK, `number`, `title`, `body` nullable,
  `state` (`open|closed`), `author_login`, `labels` JSONB (list of `{name, color}`),
  `assignees` JSONB (list of logins), `milestone_title` nullable, `comments_count` int,
  `is_pull_request` bool (REST issues list includes PRs — flagged, filtered out of counts),
  `gh_created_at`, `gh_updated_at`, `gh_closed_at` nullable, `synced_at`.
  Unique constraint on (`repository_id`, `number`).
- `sync_jobs`: `id` serial, `repository_id` FK, `kind` (`full|incremental`),
  `status` (`running|success|error`), `started_at`, `finished_at` nullable,
  `issues_upserted` int default 0, `error` nullable text

SQLAlchemy models in `backend/app/models.py`; all timestamps timezone-aware UTC.

## 3. Sync pipeline (ARQ)

- **Job** `sync_repository(repo_id, full=False)` in the worker: set `sync_status=syncing`;
  create `sync_jobs` row; page through
  `GET /repos/{full_name}/issues?state=all&sort=updated&direction=asc&per_page=100`
  with `since = last_synced_at − 5min` overlap unless `full`; upsert each issue
  (PG `INSERT ... ON CONFLICT (id) DO UPDATE`) — idempotent, keyed on GitHub ids;
  update `repository.last_synced_at` to max `gh_updated_at` seen, recompute
  `open_issues_count` (excluding PRs), set `sync_status=idle`; on exception set
  `sync_status=error` + `sync_error` and mark the job row `error`. Re-running is always safe.
- **Discovery** `refresh_installations()` (called by the API, runs inline, not queued):
  list installations → list `installation/repositories` per installation → upsert
  `installations` + `repositories` rows; repos no longer accessible are deleted
  (cascades issues).
- **Reconciliation:** ARQ cron every 30 min → incremental `sync_repository` for every repo.
- Delivery-ID dedup and event-driven sync arrive with the webhook slice.

## 4. API + Repositories page

Backend router `backend/app/routers/repositories.py` (mounted at `/repositories`):
- `GET /repositories` → list with sync fields (pydantic response models)
- `POST /repositories/refresh` → run discovery, return updated list
- `POST /repositories/{id}/sync?full=<bool>` → enqueue ARQ job, return 202 `{"queued": true}`
- Errors use the established `{"detail": ...}` shape; missing App config → 503 with
  actionable detail ("GitHub App not configured — see README").

Frontend `/repositories` (replaces placeholder): TanStack Query via the proxy;
floating-card rows — `full_name`, private badge, open-issue count, last-sync relative time,
sync-status dot (tokens: idle=muted, syncing=accent, error=red via a new `--color-danger`
token pair added to globals.css), accent-tint **Sync** button per row; header actions:
**Refresh from GitHub**. Query polls (refetch interval ~3 s) while any repo is `syncing`.
Empty state teaches the App install steps and links to the GitHub Apps settings page.
All colors via tokens; parenthesis syntax; nothing hidden when inactive.

## 5. Testing

- **Auth/client (respx-mocked):** JWT claims shape; installation-token caching (second call
  hits cache); pagination follows Link headers; 403-rate-limit raises with reset time.
- **Sync job (live PG, mocked GitHub):** run `sync_repository` twice on the same fixture
  payload → identical row counts (idempotency); PR entries flagged `is_pull_request` and
  excluded from `open_issues_count`; `since` cursor advances; error path sets
  `sync_status=error` and the job row.
- **API (live PG, mocked client):** GET empty → `[]`; refresh upserts; sync returns 202 and
  enqueues (arq pool mocked); unconfigured App → 503 detail.
- **Playwright:** `/repositories` renders the empty state against the real backend with no
  App configured (config-missing state is itself a designed screen, not an error page).
- CI unchanged (backend job already has PG+redis; respx keeps GitHub out of CI).

## Out of scope (explicitly)

Webhooks/smee tunnel, write-back to GitHub (all §2.1 fields stay read-only), issue comments
sync, the issues table UI (#4), classification/scoring (#5), rate-limit optimization
(ETags/conditional requests), multi-account installations, App marketplace publishing.

## Workflow

Branch `feat/github-sync`. Board #3 In Progress (already set) → Done only after merge.
Same subagent-driven execution with model tiers; pause before PR/merge per house rules.
