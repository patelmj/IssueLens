# Slice 6 — Issue Readiness Scoring Engine + Explainable Results

**Date:** 2026-07-20
**Issue:** #6 (Readiness scoring engine + explainable results, P1)
**Spec references:** product spec §6 (Issue Readiness Scoring), §6.1–6.3 (per-type rubrics), §6.4 (explainable readiness result), §7 / §7.1 (spreadsheet table — `Readiness score` column, `Readiness < N` filter)
**Depends on:** Slice 5 (#5) classification — every readiness score is computed against the rubric selected by the issue's classified `type`.

## Goal

Every classified (non-PR) issue gets an **explainable readiness score** (0–100) computed against a
**type-specific rubric**. The score is a deterministic weighted sum; a local LLM (the existing Ollama
stack) only judges whether each rubric requirement is present. The issues table gains a sortable
`Ready` column, a `Readiness <` threshold filter, and a row-expand drawer showing the +/- factor
breakdown from spec §6.4.

Readiness is the second brick of the Triage & Scoring track: it consumes classification (#5) and its
drawer is built to host the triage inbox's diff/approve flow (#7).

## Decisions made during brainstorm

| Decision | Choice |
|---|---|
| Scoring engine | **LLM presence + deterministic sum** — Ollama returns `present`/`evidence` per rubric requirement; `score = Σ points where present`. Math is auditable; the model never emits the number. |
| Rubric coverage | **All five types scored.** Bug/Feature/Debt verbatim from spec §6.1–6.3; two new lightweight rubrics authored for `docs` and `question`. |
| Explainable UI | **Row-expand drawer** in the existing issues table (`/plan`). Clicking the `Ready` cell expands a panel with the score + present/missing factor groups. |
| Threshold filter | `max_readiness` query param → `WHERE score < max_readiness`. Unscored issues are excluded while the filter is active. |
| Pipeline integration | Stale-driven arq job chained after classify (`sync → classify → readiness`) + cron safety-net sweep; results in a separate `issue_readiness` table. |
| Scope boundary | Engine + storage + column/filter + explainable drawer only. The §6.4 **diff** and Approve/Edit/Reject/Save/Ask-author **push-to-GitHub** actions are deferred to the triage inbox (#7). |

## The five rubrics

Bug, Feature, and Technical Debt are transcribed **verbatim** from spec §6.1–6.3 and MUST sum to 100.

**Bug (§6.1):** Problem statement 15 · Expected behavior 15 · Actual behavior 15 · Reproduction steps 20 · Environment or version 10 · Logs, screenshots, or error output 10 · Severity or impact 10 · Ownership or category 5 → **100**

**Feature (§6.2):** User or business problem 20 · Desired outcome 15 · Acceptance criteria 20 · Scope boundaries 15 · Technical constraints 10 · Dependencies 10 · Ownership or category 5 · Estimate 5 → **100**

**Technical Debt (§6.3):** Current implementation 15 · Why it is a problem 20 · Affected systems 15 · Proposed direction 15 · Risk of changing it 10 · Definition of done 15 · Dependencies 10 → **100**

Two new lightweight rubrics (net-new for this slice; both MUST sum to 100):

**Docs:** What is wrong or missing 30 · Where it lives (page / section / file / URL) 25 · Who it affects or why it matters 20 · Proposed correction or direction 25 → **100**

**Question:** Context or goal (what they are trying to do) 30 · Specific question clearly stated 30 · What they have already tried 25 · Environment or version, if relevant 15 → **100**

Each rubric requirement has a stable **id** (snake_case, e.g. `problem_statement`, `repro_steps`) used
as the JSONB factor key and the structured-output schema key. Requirement ids MUST be unique within a
rubric and stable across runs (they key the stored `factors`).

## Part A — Scoring module (`backend/app/llm/readiness.py`)

Mirrors `app/llm/classify.py` in shape.

- **Rubric tables** — a `RUBRICS: dict[str, list[Requirement]]` keyed by the five types, where
  `Requirement` carries `id`, `label` (human phrasing for prompt + drawer), and `points`. A module-load
  assertion verifies each rubric sums to 100 (guards against typos in the point tables).
- `build_prompt(repo_full_name, issue, issue_type, rubric)` — lists the rubric requirements and asks the
  model, for each, whether the issue body satisfies it. Body truncated to `MAX_BODY_CHARS` (reuse 4000).
  Prompt states the taxonomy definition of the type so the judgment is anchored.
- `stale_readiness_query(repo_id) -> Select` — see Part B.
- `score_repository_issues(session, client, repo_id) -> int` — the job body:
  1. `SyncJob(kind="readiness", status="running")`, commit, capture `job_id` (same pattern as classify).
  2. `ensure_model(client)` (reused from `ollama.py`).
  3. Iterate stale issues (each row carries the issue + its classification). For each: select the rubric
     by `issue_type`, build the prompt, call `score_readiness(...)`. On `httpx.HTTPError` /
     `ReadinessError`, log and `continue` (skip that issue — same resilience as classify).
  4. Compute `score = sum(r.points for r in rubric if result[r.id].present)`; build `factors` = every
     rubric requirement as `{requirement, points, present, evidence}` (evidence null when absent/omitted).
  5. `pg_insert(...).on_conflict_do_update(index_elements=["issue_id"], ...)`; commit per issue.
  6. On success: `job.status="success"`, `job.issues_upserted=scored`, `finished_at=now()`. On outer
     exception: rollback, reload job, `status="error"`, truncate `error` to 500, re-raise.

### LLM call (`backend/app/llm/ollama.py`, new function)

- `ReadinessError(Exception)` — analogous to `ClassificationError`.
- `readiness_schema(rubric) -> dict` — builds a per-rubric JSON Schema: an object with one property per
  requirement id, each `{"type":"object","properties":{"present":{"type":"boolean"},
  "evidence":{"type":["string","null"]}},"required":["present"]}`, all requirement ids `required`. This
  forces the model to address every requirement (Ollama honors `format` schemas well).
- `score_readiness(client, prompt, rubric) -> dict[str, dict]` — POST `/api/chat` with
  `format=readiness_schema(rubric)`, `temperature: 0`, `think: false`, `stream: false` (identical call
  shape to `classify`). Parse JSON; `_normalize_readiness` coerces each requirement to
  `{present: bool, evidence: str|None}` (evidence trimmed, capped at a sane length e.g. 200 chars,
  empty→None), raising `ReadinessError` on missing keys or non-JSON. Any requirement id absent from the
  model output defaults to `present=False, evidence=None` (never crash on a lazy model; the missing
  requirement simply scores 0).

## Part B — Data model & staleness

New table `issue_readiness` (SQLAlchemy model + Alembic `0005_issue_readiness.py`):

| Column | Type | Notes |
|---|---|---|
| `issue_id` | BigInt PK, FK→`issues(id)` ON DELETE CASCADE | one row per issue |
| `issue_type` | Text | rubric used; snapshot so classification drift is detectable |
| `score` | Integer | 0..100, deterministic Σ |
| `factors` | JSONB | `[{requirement, points, present, evidence}, ...]` — **all** rubric items, in rubric order |
| `model` | Text | `get_settings().ollama_model` |
| `scored_at` | timestamptz, server_default now() | |
| `issue_gh_updated_at` | timestamptz | staleness snapshot vs issue body |
| `classification_scored_at` | timestamptz | snapshot of the classification's `classified_at` (drift detection) |

`stale_readiness_query(repo_id)` selects `Issue` **joined to** `IssueClassification` (inner — an issue
without a classification has no rubric yet, so it is skipped) and left-joined to `IssueReadiness`, where
`Issue.repository_id == repo_id`, `NOT is_pull_request`, and:

```
IssueReadiness.issue_id IS NULL                                   -- never scored
OR Issue.gh_updated_at > IssueReadiness.issue_gh_updated_at       -- body changed
OR IssueClassification.classified_at > IssueReadiness.classification_scored_at  -- re-classified
```

Ordered by `Issue.id`. The query returns `(Issue, IssueClassification)` so the job has the type without a
second lookup.

## Part C — Job orchestration (`backend/worker.py`)

- New task `score_readiness_repository(ctx, repo_id)` — opens a session + `make_ollama_client()`, calls
  `score_repository_issues`. Registered in `WorkerSettings.functions`.
- `classify_repository` enqueues readiness on completion:
  `redis.enqueue_job("score_readiness_repository", repo_id, _job_id=f"readiness-{repo_id}")`
  (guard `redis is not None`, mirroring how `sync_repository` chains classify). This extends the chain to
  `sync → classify → readiness`.
- New cron sweep `score_all_repositories(ctx)` — enqueues `score_readiness_repository` for every repo via
  the `readiness-{repo_id}` dedupe key (safety net for issues classified while Ollama was down), mirroring
  `classify_all_repositories`. Registered at `cron(..., minute={20, 50})` — offset from classify's
  `{15, 45}` so a fresh classification is generally in place before the readiness sweep fires.
- `keep_result = 0` stays (dedupe keys must be re-enqueueable within the hour — the slice-4/5 gotcha).

## Part D — API (`backend/app/routers/issues.py`)

- `IssueOut` gains `readiness_score: int | None`. `_filtered_query` outer-joins `IssueReadiness`
  (alongside the existing `IssueClassification` join) and the list projection reads
  `readiness.score if readiness else None`.
- **Filter:** new `max_readiness: int | None = Query(None, ge=0, le=100)`. When set,
  `WHERE IssueReadiness.score < max_readiness` (strict `<`, matching "Readiness < 80"). Unscored issues
  (`score IS NULL`) are excluded while the filter is active.
- **Sort:** add `"readiness": IssueReadiness.score` to `SORT_COLUMNS`; extend the `sort` Literal. NULLs
  sort last in both directions (use `.nulls_last()` on the ordering column) so unscored issues never
  crowd the top.
- **Breakdown endpoint:** `GET /issues/{issue_id}/readiness` → `ReadinessOut{score, issue_type,
  scored_at, factors: list[FactorOut]}` where `FactorOut{requirement, points, present, evidence}`. 404
  when the issue has no readiness row. Factors are kept **out** of the list payload (heavy) and lazy-loaded
  by the drawer.

## Part E — Frontend (`frontend/src/app/plan/`)

> Heed `frontend/AGENTS.md`: this Next.js has breaking changes — read the relevant guide in
> `node_modules/next/dist/docs/` before writing component code. Auto-load `sketch-findings-issuelens`
> for the drawer's visual treatment and existing token usage.

- **`plan-client.tsx`:**
  - `IssueRow` gains `readiness_score: number | null`. `SortKey` gains `"readiness"`. `ColumnKey` gains
    `"ready"`; `COLUMNS` gets `{ key: "ready", label: "Ready", sort: "readiness", defaultVisible: true }`
    (placed after `component`, matching spec §7.1 column order).
  - `Ready` cell: renders `{score}%` as a **button** (muted `—` when null), tinted by score band
    (red < ~40, amber < ~75, green ≥ ~75 — exact thresholds/colors per the sketch-findings tokens; keep
    the element visible-but-muted when null, never hidden — house rule). Clicking toggles
    `expandedId === row.id`.
  - **Drawer:** when `expandedId === row.id`, render an expanded `<tr>` spanning all visible columns
    containing a panel that `useQuery`s `/api/backend/issues/{id}/readiness`. Shows the score header, then
    two groups — **present** (✓, green, `+label (points)`) and **missing** (✗, red, `-label (0/points)`),
    each with its `evidence` phrase when present. Loading + error states handled inline.
  - `max_readiness` is read from `searchParams` and forwarded to the backend query when set.
- **`toolbar.tsx`:** a "Readiness <" threshold control (a small `select` of thresholds like
  `Any / <90 / <75 / <50 / <25`, or a numeric input — pick the cleaner fit with the existing controls)
  wired to `setParams({ max_readiness, offset: null })`. Add the `ready` column to the Columns toggle
  (already driven by `COLUMNS`, so it appears automatically). **No** diff/approve actions (that is #7).

## Part F — Testing

- **`backend/tests/test_readiness.py`** — rubric sums equal 100 (all five); `score = Σ present points`
  for hand-built factor sets per rubric; `_normalize_readiness` (trims/caps evidence, missing key →
  `present=False`, non-JSON → `ReadinessError`); `readiness_schema` shape; `build_prompt` includes every
  requirement label; `stale_readiness_query` returns exactly the three stale cases and **excludes**
  unclassified issues and up-to-date rows.
- **`backend/tests/test_readiness_worker.py`** — `classify_repository` enqueues
  `score_readiness_repository` with the `readiness-{repo_id}` dedupe key; `score_all_repositories`
  enqueues one job per repo; cron registration present. (Mirror `test_classify_worker.py`.)
- **`backend/tests/test_api_issues.py`** (extend) — `readiness_score` present in list payload;
  `max_readiness` filter narrows and excludes unscored; `sort=readiness` orders with NULLs last;
  `GET /issues/{id}/readiness` returns factors and 404s when absent.
- **`frontend/e2e/readiness.spec.ts`** (Playwright) — `Ready` column renders scores; clicking a cell
  expands the drawer with present/missing factors; the threshold filter narrows the table. Gotchas:
  `docker restart issuelens-frontend-1` before the run (stale dev build); wrap click+assert in
  `expect(...).toPass()` (hydration race).

## Non-goals (explicit)

- The §6.4 **proposed-change diff** and the Approve / Edit / Reject / Save-as-suggestion / Ask-author
  **push-to-GitHub** actions → triage inbox (#7). The drawer is structured to host them later.
- No new readiness cron beyond the single `{20, 50}` sweep; no per-issue manual re-score button.
- No endpoint auth / `sync_error` sanitization (tracked in the deferred auth slice; unchanged here).

## Execution

Subagent-driven development with explicit model tiers (house tiering in CLAUDE.md), tracked in
`.superpowers/sdd/progress.md`. Backend engine + migration + worker + API, then frontend column + drawer +
filter, then live verification against the dogfooded repos (qwen3:8b). Per-task sonnet reviews; final
whole-branch review on the most-capable model.
