# Slice 5 — Issue Classification (type + component) & Dedicated Test Database

**Date:** 2026-07-19
**Issues:** #5 (Issue classification: type + component, P1), #19 (Separate test database, P1)
**Riders:** #17 (header chip), #20 (top-repos test)
**Spec references:** product spec §5.1 (triage categories), §6 (type-specific readiness tracks), §7.1 (table columns), §17 (classification worker), §18.3 (structured-output classification), §21.1 item 5

## Goal

Every synced (non-PR) issue gets a machine-suggested **type** (`bug` / `feature` / `debt` / `question` / `docs`) and **component** (short free-text area like `auth`, `sync`, `frontend`), produced by a **local LLM (Ollama)** running in docker-compose — no external API, no API key, no new Python dependency. The issues table lights up its Type and Component columns with matching toolbar filters.

Alongside, `uv run pytest` stops truncating the dogfooded dev database by moving all tests to a dedicated `issuelens_test` database (#19).

Classification is the first brick of the Triage & Scoring track: it feeds readiness scoring (#6) and the triage inbox (#7).

## Decisions made during brainstorm

| Decision | Choice |
|---|---|
| Engine | Local LLM via **Ollama in docker-compose** (user preference over Claude API; hardware: RTX 5080 + 31 GB RAM) |
| Type taxonomy | `bug`, `feature`, `debt`, `question`, `docs` — the spec's three readiness tracks plus two escape categories |
| Component vocabulary | Open vocabulary with consistency hints (repo label names + components already assigned in the repo are fed into the prompt) |
| UI scope | Type + Component columns in the issues table, plus toolbar filters for both |
| Pipeline integration | Stale-driven arq job triggered after sync + cron safety net; results in a separate `issue_classifications` table |

## Part A — Dedicated test database (#19)

**Problem:** `backend/tests/conftest.py` pins `ISSUELENS_DATABASE_URL` to the dev `issuelens` database, and the `clean_db` fixture truncates `installations, repositories, issues, sync_jobs` — every pytest run wipes real synced data (happened twice during the slice-4 build).

**Design:**

- Tests use `issuelens_test`, a second database in the **same** pgvector container. No docker-compose changes.
- New **session-scoped autouse fixture** in `conftest.py`:
  1. Connects to the Postgres server (maintenance connection to the `issuelens` database with the existing credentials).
  2. `CREATE DATABASE issuelens_test` — the "already exists" error is caught and ignored.
  3. Runs `alembic upgrade head` programmatically against `issuelens_test`, so the test schema is built by the real migrations (migrations get exercised on every test session).
- `pin_env` changes its pinned URL to `...@localhost:5432/issuelens_test`. Everything else (`clean_db` truncation, engine cache clearing) stays as-is — truncation is now harmless.
- The dev database remains reserved for the live stack and dogfooding.

**Edge cases:** first run on a fresh machine creates the DB automatically; concurrent creation races are absorbed by the catch; if Postgres isn't running, tests fail fast with a clear connection error (same as today).

## Part B — Ollama service

**docker-compose:** new `ollama` service —

- Image `ollama/ollama`, named volume (e.g. `ollamadata:/root/.ollama`) for model storage.
- NVIDIA GPU reservation (`deploy.resources.reservations.devices` with `driver: nvidia`) — Docker Desktop/WSL2 passes the RTX 5080 through. If the host lacks the NVIDIA container runtime, the GPU reservation makes the service fail to start — remove the `deploy:` block to run Ollama on CPU (slower but functional).
- Port `127.0.0.1:11434` published for local debugging.
- `backend`/`worker` get `ISSUELENS_OLLAMA_URL: http://ollama:11434`.

**Settings (`app/config.py`):**

- `ollama_url: str = "http://localhost:11434"`
- `ollama_model: str = "qwen3:8b"` (~5 GB one-time download; configurable)

**LLM client (`app/llm/ollama.py`):** thin `httpx`-based client — no new dependency.

- `ensure_model()` — checks `/api/tags`; if the configured model is absent, calls `/api/pull` (blocking) so first classification run bootstraps itself. Pull progress is logged.
- `classify(prompt, schema)` — POST `/api/chat` with `stream: false`, `think: false`, `options: {temperature: 0}`, and `format: <JSON schema>` so the model is constrained to:

```json
{
  "type": "object",
  "properties": {
    "type": {"type": "string", "enum": ["bug", "feature", "debt", "question", "docs"]},
    "component": {"type": ["string", "null"]},
    "confidence": {"type": "number"}
  },
  "required": ["type", "component", "confidence"]
}
```

## Part C — Data model & classification job

**New table `issue_classifications`** (alembic migration `0003`):

| Column | Type | Notes |
|---|---|---|
| `issue_id` | BIGINT PK, FK → `issues.id` ON DELETE CASCADE | 1:1 with issues |
| `issue_type` | TEXT | one of the 5 taxonomy values |
| `component` | TEXT NULL | normalized: lowercased, trimmed, empty → NULL |
| `confidence` | DOUBLE PRECISION | model-reported, clamped to [0, 1] |
| `model` | TEXT | e.g. `qwen3:8b`, for provenance |
| `classified_at` | TIMESTAMPTZ, server default now | |
| `issue_gh_updated_at` | TIMESTAMPTZ | snapshot of the issue's `gh_updated_at` at classification time |

**Staleness predicate** (the single driver for backfill, incremental re-classification, and retry):
an issue needs classification iff it has no row, or `issues.gh_updated_at > issue_classifications.issue_gh_updated_at`.

A separate table (rather than columns on `issues`) means `sync_repository_issues`'s blanket column upsert can never clobber classification data, and future intelligence tables (readiness) follow the same pattern.

**arq job `classify_repository(ctx, repo_id)`** (`app/llm/classify.py` + registration in `worker.py`):

1. `ensure_model()`.
2. Create a `SyncJob` row with `kind="classify"` (reuses existing job observability; `issues_upserted` = count classified).
3. Gather consistency hints: distinct `component` values already assigned in this repo, plus the repo's label names (from synced issue labels).
4. Select non-PR issues matching the staleness predicate.
5. Per issue: build prompt (repo full name, issue title, body truncated to ~4,000 chars, label names, hint lists), call Ollama, normalize + clamp, upsert the classification row with the `gh_updated_at` snapshot. Per-issue failures are logged and skipped — the issue stays stale and is retried on the next run.
6. Mark the `SyncJob` success/error with counts.

**Triggers:**

- `sync_repository` (worker) enqueues `classify_repository` after a successful sync, with a deterministic `_job_id` (`classify-{repo_id}`) so overlapping triggers dedupe (`keep_result=0` already makes re-enqueue safe).
- Cron `classify_all_repositories` at :15 and :45 (offset from the sync reconcile at :00/:30) as a safety net for anything missed.
- Ollama being down fails only the classify job (recorded on its `SyncJob` row); sync is never blocked by the LLM.

## Part D — API & UI

**API (`routers/issues.py`):**

- Issues list query LEFT JOINs `issue_classifications`; each row gains `issue_type`, `component`, `classification_confidence` (all nullable — null means not yet classified).
- New filter params: `type` (validated against the 5-value taxonomy) and `component` (exact match, normalized form).
- The existing `GET /issues/facets` endpoint (which already serves the label and assignee dropdowns) gains a `components` list — distinct non-null components, honoring the same `repo_id` param — feeding the component filter dropdown. (Amended during planning from a separate `GET /issues/components` endpoint: facets is the established pattern for filter vocabularies.)

**Frontend (issues table + toolbar):**

- **Type** column: colored badge per taxonomy value; unclassified shows a muted placeholder (visible but dimmed — never hidden, per house UI rules).
- **Component** column: plain text; muted placeholder when null.
- Toolbar: type filter (5 fixed options) and component filter (options from the components endpoint), following the existing slice-4 filter patterns (URL-synced params, filters passed to the API).
- Both columns participate in the existing column-visibility control.
- The `sketch-findings-issuelens` skill is loaded during UI implementation for visual decisions.

## Part E — Error handling

| Failure | Behavior |
|---|---|
| Ollama unreachable / model pull fails | Classify job marks its `SyncJob` row error; sync unaffected; issues stay stale and retry on next trigger |
| Per-issue LLM error (timeout, malformed output despite schema) | Logged, skipped; issue stays stale for retry |
| Confidence out of range | Clamped to [0, 1] |
| Component junk (empty, whitespace, over-long) | Normalized; empty → NULL; length capped |
| GPU unavailable | Ollama runs on CPU — slower, functionally identical |

## Part F — Testing

- **Backend (pytest, now against `issuelens_test`):** respx-mocked Ollama for the client and the classify job (happy path, per-issue failure, model-pull path); staleness predicate unit tests; upsert/re-classification tests; API tests for the new fields, `type`/`component` filters, and the components endpoint; migration exercised by the session fixture.
- **Frontend (Playwright, hermetic mocked API):** columns render (badges, muted unclassified state), filters round-trip to API params, component dropdown populated from the endpoint.
- **Live verification (end of slice):** full compose stack up, model pulled, real synced issues classified; verify columns and filters in the running app via Playwright CLI; confirm `uv run pytest` leaves dogfood data intact (#19 acceptance).

## Part G — Riders

- **#17** — header chip (small UI task, independent).
- **#20** — top-repos test (small backend test task, independent).

## Out of scope

- Readiness scoring (#6), triage inbox views (#7), classification approval/override flow (spec §7.2 "Approve suggested classifications"), webhooks, closed-issue exclusion rules, per-repo curated component lists.
