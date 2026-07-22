# Saved Views for Table + Board, Repo-Grouped Library — Design

**Date:** 2026-07-22
**Issue:** [#8](https://github.com/patelmj/IssueLens/issues/8)
**Status:** Approved design, pre-implementation

## Context

Slice 10 (#33) shipped the saved-views machinery — generic `saved_views` table
(`view_kind` + JSONB `filters`), CRUD `/views` router, save popover, sidebar Library
links, and a `/views` page — but wired it for the matrix only. This slice extends
saved views to the issues table (`/plan`) and the kanban board (`/plan/board`),
and reorganizes the Library for a mixed, multi-kind collection.

## Decisions (from brainstorm)

| Question | Decision |
| --- | --- |
| Library organization | **Group by repository** (not by kind, not flat). Kind is shown as a badge per item. Rationale: the working flow rarely leaves a repo. |
| Repo-less table views | **Not allowed.** A repository is required to save a view of any kind. There is no cross-repo/all-repos workflow. |
| Ordering | **Manual drag reordering** within each repo group, on the `/views` page. Sidenav follows the same order. |
| Table view captures | Filters + sort/order. **Not** pagination `offset`, **not** column visibility. |
| Board view captures | `lane_by` + filter chips. The board **gains matrix-style filter chips** (issue-type multi-select + readiness buckets) as part of this slice. |

## Goals

1. Save, list, open, rename, delete, and reorder views of kind `table` and `board`
   alongside existing `matrix` views.
2. Board surface gains type/readiness filter chips and a URL-backed `lane_by`.
3. Library (sidenav + `/views`) groups by repository with kind badges and
   user-controlled ordering.

## Non-Goals

- Pinned favorites or a "default view per surface" (deferred; revisit if the
  collection grows).
- Column visibility in table views (would first require promoting it to URL state).
- Board filters beyond the shared type/readiness model (e.g. label/assignee chips).
- Reordering from the sidenav (drag lives on `/views` only).

## 1. Backend

### Kind validation and repo requirement

- `VIEW_KINDS = {"matrix", "table", "board"}` in `backend/app/routers/views.py`.
- `repository_id` is **required for every kind** — 422 when null. This replaces the
  matrix-only special case. The DB column stays nullable (all existing rows are
  matrix views that already have a repo; enforcement is at the API layer).

### Ordering

- **Migration 0011:** add `position` (integer, not null, server default `0`) to
  `saved_views`. Backfill: within each `repository_id`, assign 0..n−1 by
  `created_at, id`.
- Create appends: new views get `max(position) + 1` within their repo.
- `GET /views` orders by `repository_id, position, id` (was `created_at desc`).
- `SavedViewOut` gains `position`.

### Reorder endpoint

`PUT /views/order` with body `{repository_id: int, ordered_ids: [int, ...]}`:

- 404 if the repo doesn't exist.
- 422 unless `ordered_ids` is exactly the set of view ids belonging to that repo
  (no omissions, no foreign ids, no duplicates).
- Assigns `position = index` for each id. Returns the reordered list.

One request per completed drag-drop.

## 2. Board filters (new surface work)

- `/plan/board` gains the matrix's filter chips — issue-type multi-select +
  readiness buckets — reusing `frontend/src/lib/matrix-filters.ts` wholesale:
  same `types` / `readiness` URL params, same `parseFilters` / `applyFilters`.
- Filtering is client-side over `KanbanCard.issue_type` and
  `KanbanCard.readiness_pct` (both already in the kanban payload — no API change).
  Column counts reflect the filtered cards.
- `laneBy` moves from React state to a `lane_by` URL param
  (`none | component | assignee`, default `none`, invalid values fall back to
  `none`).
- Board URL state becomes `repo_id`, `lane_by`, `types`, `readiness` — fully
  shareable and saveable.

## 3. Per-kind view model (frontend)

A kind registry in `frontend/src/lib/views.ts` replaces the hardcoded matrix
assumptions. Each kind declares:

```
{ label, route, filtersFromJson, toSearch, summary }
```

- **matrix** → `/plan/matrix` — existing `matrix-filters.ts` codec, unchanged.
- **table** → `/plan` — new `frontend/src/lib/table-filters.ts` with
  `TableViewFilters = { state, label, assignee, q, type, component,
  max_readiness, sort, order }`, a JSONB sanitizer (`filtersFromJson`), URL codec,
  and a human summary (e.g. "Open · bug · readiness ≤40 · by readiness ↓").
- **board** → `/plan/board` — `BoardViewFilters = { lane_by, types, readiness }`
  (types/readiness delegate to the matrix codec), summary like
  "Laned by assignee · Bug, Debt · Ready".

`savedViewHref(view)` routes by kind. Views with an unknown `view_kind` render
inert — badge + name, no open link — never crash.

All `filtersFromJson` implementations treat stored JSONB as untrusted input:
unknown keys dropped, invalid values coerced to defaults (matrix precedent).

## 4. Save affordances

`SaveViewButton` (currently matrix-only at
`frontend/src/app/plan/matrix/save-view.tsx`) generalizes to a shared component
taking `{ view_kind, repository_id, filters }`, mounted on all three toolbars.

- **Enablement:** a repo is selected AND at least one non-default parameter is
  active. Matrix keeps its existing `hasActiveFilters` rule; table = any filter,
  search, or non-default sort; board = `lane_by !== "none"` or any chip active.
- Same popover UX and per-kind 409 duplicate-name handling as today
  (`(view_kind, name)` uniqueness is already the DB constraint).
- On success: invalidate `VIEWS_KEY` (existing pattern).

## 5. Library IA — `/views` page + sidenav

### `/views` page

- Sections per repository, header = repo name (repos with no views are omitted).
- Each row: drag handle · kind badge (Matrix / Table / Board) · name · per-kind
  filter summary · Open / Rename / Delete (existing interactions preserved,
  including two-click delete confirm with `isPending` guard).
- **Drag reorder** within a repo section: 1-D pointer-drag reusing the kanban
  pattern (6px threshold, `elementsFromPoint`), optimistic reorder with rollback
  + inline error on failure (matrix pin-error precedent — not a toast).
  Cross-section drops are rejected (item snaps back).

### Sidenav Library

- Inline links under "Saved Views" show **all kinds** (was: matrix only),
  grouped by repo with a small muted repo label, ordered by `position`, each
  with a compact kind indicator.
- The count pill keeps counting all views — now correct rather than divergent,
  resolving the slice-10 review note.
- Active-state matching becomes kind-aware: canonical URL comparison per kind
  (pathname + kind's `toSearch` of parsed current params).

## 6. Error handling

- Reorder failure: optimistic order rolls back, inline error message in the
  `/views` section header area.
- Save failures: existing popover error states (409 name conflict per kind,
  network error) reused for the new kinds.
- Stored-filter drift (e.g. a saved view referencing a component that no longer
  exists) is not validated — opening the view simply yields an empty/filtered
  result, same as a stale URL.

## 7. Testing

- **Backend (pytest):** kind validation for `table`/`board`; repo-required 422
  for all kinds; reorder endpoint happy path, cross-repo id rejection,
  missing/duplicate id rejection, position assignment; create-appends-position;
  migration 0011 up/down + backfill order.
- **Frontend e2e (Playwright CLI):**
  - Board chips filter cards and column counts; `lane_by` survives reload via URL.
  - Save a table view → appears in sidenav under its repo → open restores
    filters + sort.
  - Save a board view → open restores `lane_by` + chips.
  - Drag reorder on `/views` persists across reload; sidenav order matches.
  - Existing matrix save/open flows unchanged.
- **Live dogfood** on the real synced repo before merge (save/open/reorder all
  three kinds).

## Follow-ups (out of scope, file as issues if wanted)

- Pinned favorites / default view per surface.
- Column visibility captured in table views.
- Sidenav drag reordering.
