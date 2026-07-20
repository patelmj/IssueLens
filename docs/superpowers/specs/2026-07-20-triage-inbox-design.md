# Slice 7 — Triage Inbox (Needs-Detail queue → scaffold suggestions → diff → approve/push)

**Issue:** #7 · Area: Triage & Scoring · P1
**Spec references:** §5 Triage Inbox, §5.1 Triage Categories, §6.4 Explainable Readiness Result, §21.1 MVP 1 items 7–10, §22 steps 4/6
**Builds on:** slice 6 readiness scoring (`issue_readiness` table + per-factor `factors` JSONB, `GET /issues/{id}/readiness`, the `/plan` readiness drawer).

---

## 1. Goal

Turn the read-only readiness data into an actionable triage loop:

1. A **Needs-Detail inbox** — classified issues below a readiness threshold, each showing *which* rubric requirements are missing as category chips.
2. **Suggest missing sections** — for a chosen issue, deterministically scaffold the missing rubric sections into a proposed issue body.
3. **Preview the change as a diff** — a server-computed unified diff of current → proposed body.
4. **Approve / Edit / Reject / Save-as-suggestion**, and on approve, **push the new body to GitHub** with write-safety.

This delivers §21.1 MVP 1 items 7, 8, 9, 10 and §22 steps 4 and 6.

### Non-goals (explicitly deferred)

- **"Ask issue author"** action (§6.4's 5th action) — needs comment-write, a different write surface. Filed as a separate `/todos` follow-up.
- **Full 11-category §5.1 taxonomy** (Possible duplicate, Blocked, Needs owner, Ready as a workflow state) — needs duplicate detection, dependency parsing, and ownership inference, all MVP 2 subsystems. This slice derives category chips only from *already-computed* missing rubric factors.
- Any LLM call for suggestion content — see §3, scaffolds are deterministic.

---

## 2. Key decisions (locked in brainstorming)

| Decision | Choice | Rationale |
|---|---|---|
| Suggestion content | **Scaffold templates only** — empty section headings + guiding prompts, never fabricated facts | Honors "the AI should never silently modify an issue"; zero hallucination risk; fully explainable |
| Suggestion source | **Deterministic**, driven by the readiness `factors` JSONB (`present:false`) | No new model call; the missing requirements are already computed |
| Write-back | **Real PATCH to GitHub** + persistence table for Save-as-suggestion | Full §6.4 flow |
| Proposal persistence | **One active suggestion per issue**; regenerate replaces a `draft` | Simpler data model; no history in this slice |
| Diff | **Server-side, stdlib `difflib`** returning structured hunks | No new npm dependency; robust to user edits |
| Inbox scope | **Needs-Detail queue + derived chips** | Matches item 7 exactly; no new detection subsystems |

---

## 3. Scaffold engine — `backend/app/triage/scaffold.py`

Pure, deterministic, no I/O.

```python
# One scaffold snippet per rubric requirement id (ids match RUBRICS in readiness.py).
SCAFFOLDS: dict[str, str] = {
    "repro_steps": "## Reproduction Steps\n<!-- Minimal steps to reproduce -->\n1. \n2. \n3. \n",
    "environment": "## Environment\n- OS / version: \n- App / dependency version: \n",
    "logs": "## Logs / Error Output\n<!-- Paste relevant logs, stack traces, or screenshots -->\n```\n\n```\n",
    "acceptance_criteria": "## Acceptance Criteria\n- [ ] \n- [ ] \n",
    "scope_boundaries": "## Scope\n**In scope:**\n- \n\n**Out of scope:**\n- \n",
    # … one entry for every requirement id across all five rubrics
}
```

- `SCAFFOLDS` MUST cover **every** requirement id in `readiness.RUBRICS` (asserted at import time, mirroring the existing `RUBRICS`↔`ISSUE_TYPES` assertion — this couples the two modules so a new rubric requirement can't silently ship without a scaffold).
- `build_proposed_body(current_body: str, missing_requirement_ids: list[str]) -> tuple[str, list[str]]`:
  - Start from `current_body` (or `""`).
  - For each missing id (in rubric order), append its scaffold **only if** that section heading (`## <Title>`, case-insensitive) is not already present in the body — **idempotent**: regenerating never duplicates a section, and running against a body that already has one of the sections skips it.
  - Return `(proposed_body, applied_requirement_ids)`. `applied` may be shorter than the input when some headings already exist.
- The "missing requirement ids" come from the persisted readiness `factors` (`present == false`), so the scaffold set is a direct function of the last score.

**Tests:** determinism (same inputs → identical output), idempotency (apply twice = apply once), heading-already-present skip, empty-body case, all-present → no change.

---

## 4. Data model — `issue_suggestions` (Alembic `0006`)

```python
class IssueSuggestion(Base):
    __tablename__ = "issue_suggestions"
    issue_id: BigInteger, FK issues.id ON DELETE CASCADE, PRIMARY KEY   # one active per issue
    status: Text            # 'draft' | 'suggested' | 'pushed' | 'rejected'
    base_body: Text         # snapshot of issue.body at generation — write-safety baseline
    base_gh_updated_at: DateTime(tz)   # issue.gh_updated_at at generation — staleness signal
    proposed_body: Text     # scaffolded body, possibly user-edited
    missing_requirements: JSONB   # [{"id": "...", "label": "..."}] that drove the scaffold
    edited: Boolean default False # user diverged from the deterministic scaffold
    created_at / updated_at: DateTime(tz) server_default now(), onupdate now()
    pushed_at: DateTime(tz) nullable
```

State machine:

```
(none) --POST suggestion--> draft
draft  --PATCH body/edit--> draft (edited=true)
draft  --PATCH status=suggested--> suggested   (Save as suggestion)
draft|suggested --POST push (safety ok)--> pushed
draft|suggested --PATCH status=rejected--> rejected
rejected|pushed --POST suggestion (regenerate)--> draft   (replaces the row)
```

Regenerate upserts the single row (on-conflict by `issue_id`). A `pushed` row is retained for audit until the next regenerate.

---

## 5. GitHub write path — `backend/app/github/client.py`

Read path is unchanged. Add installation-token **write** helpers (mirroring `installation_get_paginated`'s token flow):

```python
async def installation_get_one(client, installation_id, path) -> dict[str, Any]:
    # single authenticated GET, rate-limit checked — used for the pre-push re-fetch

async def installation_patch(client, installation_id, path, json) -> dict[str, Any]:
    # authenticated PATCH, rate-limit checked, raise_for_status
```

**Manual prerequisite (flag in README + spec):** the GitHub App currently holds read-only issue permission. Before push works end to end, bump the App's permissions to **Issues: Read & write** and re-accept the installation. Document in README under "GitHub App setup". Until then, generate/diff/save-as-suggestion all work; only the push endpoint returns a GitHub 403 the UI surfaces cleanly.

---

## 6. Backend endpoints

### 6.1 `GET /triage/inbox` — new `triage` router
Reuses the existing filter/sort scaffolding from `issues.py`.

Query params: `repo_id?`, `type?`, `threshold` (default 80; `readiness.score < threshold`, strict, excludes NULL — same semantics as the existing `max_readiness`), `limit`, `offset`.
Only **classified issues that have a readiness score** are eligible (an unscored issue has no missing factors to show).
Sort: readiness ascending (worst first), then issue id.

Response item:
```jsonc
{
  "id", "number", "title", "repo_full_name",
  "issue_type", "component", "readiness_score",
  "missing": [{"id": "repro_steps", "label": "Reproduction steps"}, ...],  // from factors present:false
  "suggestion_status": "draft" | "suggested" | "pushed" | "rejected" | null
}
```

### 6.2 Suggestion endpoints — under the `issues` router (colocated with `/{id}/readiness`)

| Method | Path | Behavior |
|---|---|---|
| `POST` | `/issues/{id}/suggestion` | Generate/regenerate. Requires a readiness row (else 409 "score the issue first"). Compute missing ids from `factors`, `build_proposed_body`, upsert a `draft` row snapshotting `base_body`/`base_gh_updated_at`. Return the suggestion + diff. |
| `GET` | `/issues/{id}/suggestion` | Reload current row (404 if none). Returns suggestion + diff. |
| `PATCH` | `/issues/{id}/suggestion` | Body `{proposed_body?, status?}`. Setting `proposed_body` sets `edited=true` and re-diffs. `status` may move to `suggested` or `rejected`. Rejecting a pushed row is a 409. |
| `POST` | `/issues/{id}/suggestion/push` | Approve & push — see §7. |

**Diff in responses:** every suggestion response embeds
```jsonc
"diff": [{"op": "context"|"add"|"del", "line": "..."}]
```
computed server-side with `difflib` from `base_body` → `proposed_body`. Frontend renders `add` green, `del` red, `context` muted.

### 6.3 Validation / errors
- 404 when the issue or (for GET) suggestion doesn't exist.
- 409 when: no readiness score yet; rejecting/editing a `pushed` row; push write-safety fails (§7).
- GitHub 403 (missing write scope) surfaces as a 502 with a clear `detail` the UI shows verbatim.

---

## 7. Approve & push — `POST /issues/{id}/suggestion/push`

1. Load the `draft`/`suggested` suggestion (409 if `pushed`/`rejected`/missing).
2. **Write-safety re-fetch:** `installation_get_one` the live issue. If its `body` differs from `base_body`, the issue changed on GitHub since we diffed → **409 `"issue changed on GitHub since this suggestion was generated; regenerate"`**. (GitHub issues have no ETag/If-Match, so comparison is the guard.)
3. `installation_patch(/repos/{full_name}/issues/{number}, {"body": proposed_body})`.
4. On success: update the local `Issue` row's `body` + `gh_updated_at` from the PATCH response; set suggestion `status=pushed`, `pushed_at=now()`.
5. **Re-score:** enqueue `classify_repository(repo_id)` via its existing dedupe key (`_job_id=f"classify-{repo_id}"`). The changed `gh_updated_at` makes the issue stale, so the existing `classify → readiness` chain re-scores it. No new job type.
6. Return the updated suggestion (`status=pushed`).

Errors roll back the local transaction; a GitHub failure never leaves a half-written local state.

---

## 8. Frontend — `/triage` (replaces the `PagePlaceholder`)

- **`triage/page.tsx`** → renders `TriageClient` (mirrors `plan/page.tsx` → `plan-client.tsx`).
- **`triage/toolbar.tsx`** — repo filter, type filter, readiness-threshold control. Reuse patterns/components from `plan/toolbar.tsx`.
- **`TriageClient`** — react-query `GET /api/backend/triage/inbox`. Rows show: readiness %, `TYPE · component`, a **"Missing:"** row of category chips (one per missing factor label), and actions `[Suggest fixes]` `[Open in GitHub]`. Empty state when the queue is clear.
- **`triage/suggestion-drawer.tsx`** — on "Suggest fixes", `POST …/suggestion`, then show:
  - the **diff** (structured hunks → colored lines),
  - an **editable textarea** (Edit → `PATCH proposed_body`, re-diffs on save),
  - actions **Approve & push** (`POST …/push`), **Save as suggestion** (`PATCH status=suggested`), **Reject** (`PATCH status=rejected`),
  - status badge + a clear inline error when push fails (write-safety 409 or missing GitHub scope).
- **`lib/api.ts`** — add a tiny `sendJson<T>(url, method, body)` mutation helper alongside `getJson` (POST/PATCH with JSON headers + the same error unwrapping). No new dependency.

Per project rule: CSS custom properties use `bg-(--color-x)` parentheses syntax; muted-not-hidden for inactive elements; reuse the type-color tokens already used by the readiness drawer (`--type-bug`, `--type-feature`).

---

## 9. Testing

**Backend (pytest, `issuelens_test` DB):**
- `scaffold.py`: determinism, idempotency, heading-skip, empty body, all-present.
- `GET /triage/inbox`: threshold filter, only-scored eligibility, chip derivation, suggestion-status join, repo/type filters, ordering.
- Suggestion lifecycle: generate (409 without readiness), get 404, edit sets `edited`+re-diffs, save-as-suggestion, reject, regenerate-replaces.
- Push: **GitHub PATCH mocked** — happy path updates local body + status + enqueues classify; write-safety 409 on changed body; 502 on GitHub 403.
- Diff endpoint output shape.

**Frontend (Playwright CLI, per project rule):**
- Inbox renders rows + chips against seeded data.
- Suggest fixes → diff appears; edit → save; save-as-suggestion persists across reload; approve/push (backend mocked/seeded) → status badge; reject removes from active.
- Restart `issuelens-frontend-1` before e2e (stale-build gotcha); wrap click+assert in `expect(...).toPass()` for hydration races.

---

## 10. Build order (for the implementation plan)

1. Alembic `0006` + `IssueSuggestion` model.
2. `scaffold.py` + unit tests (pure, fast).
3. GitHub write helpers (`installation_get_one`, `installation_patch`).
4. `triage` router `GET /inbox` + tests.
5. Suggestion endpoints (generate/get/patch) + diff via `difflib` + tests.
6. Push endpoint + write-safety + re-score enqueue + tests (GitHub mocked).
7. Frontend `/triage` inbox + toolbar.
8. Frontend suggestion drawer (diff/edit/actions).
9. `lib/api.ts` mutation helper.
10. Playwright e2e.
11. README: GitHub App `issues: write` prerequisite.

---

## 11. Follow-ups to file

- "Ask issue author" action (comment-write) — `/todos` item, deferred from this slice.
- Full §5.1 triage taxonomy (duplicate/dependency/owner detection) — MVP 2.
