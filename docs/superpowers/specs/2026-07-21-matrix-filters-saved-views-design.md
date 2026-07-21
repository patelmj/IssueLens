# Slice 10 — Matrix filter chips + saved matrix views

**Issue:** #33 · Area: Views & Visualization · P1
**Spec references:** §3.1 Saved Views sidebar section, §10.4 Interactions (filters, "any filtered matrix state can be saved as a sidebar view"), §19 (`saved_views`)
**Builds on:** slice 8 priority matrix (`/plan/matrix`, `GET /repositories/{id}/priority` payload already carries `issue_type`, `component`, `readiness_score`, `labels`, `assignees` per item), the app-shell sidenav, and the sketch-validated chip/control styling (`sketch-findings-issuelens`).

---

## 1. Goal

1. **Filter chips** above the matrix — type (multi-select) and readiness bucket (single-select), alongside the existing repository select — filtering the chart, execution queue, and hover set together, entirely client-side.
2. **Saved views** — any filtered matrix state can be saved under a name; saved views appear as links in the sidebar and on a real `/views` page, backend-persisted.

### Non-goals (deferred)

- Component/assignee/milestone filter chips (spec §10.4 lists them; #33 scopes to the trio)
- Saveable views for the issues table and kanban board (schema supports them via `view_kind`; UI not built)
- Per-user view ownership (no auth yet — `owner_id` arrives with the auth slice)
- View sharing/export, view reordering, default-view pinning

## 2. Key decisions (locked in brainstorming, 2026-07-21)

| Decision | Choice | Rationale |
|---|---|---|
| Filter set | **#33 trio**: repository (existing select), type, readiness bucket | Smallest surface; matches the issue as filed; the rest are follow-ups |
| Persistence | **Backend `saved_views` table + CRUD API** | Matches spec §19, survives browsers/devices, one source of truth for sidebar + `/views` |
| Schema shape | **Generic**: `view_kind` + `filters` JSONB, only `"matrix"` implemented | Issues-table/board views later without a migration |
| Readiness UI | **Preset buckets**, not a range slider | Reads as a chip, trivially serializable, no custom slider component |
| State flow | **URL-first**: filters live in search params; filtering is client-side | Deep-linkable, back/forward works, saved view = a plain link, matches existing `?repo_id=` pattern |
| Normalization | **No** `view_filters`/`view_columns` child tables | JSONB snapshot is the contract; spec §19's list is "possible", not required — YAGNI |

## 3. Data model — one Alembic migration

### `saved_views`

| Column | Type | Notes |
|---|---|---|
| `id` | BigInteger PK autoincrement | |
| `name` | Text | non-empty (API-validated) |
| `view_kind` | Text | `"matrix"` only for now; validated at API layer |
| `repository_id` | BigInteger FK → `repositories.id` `ondelete=CASCADE`, **nullable** | nullable for future non-repo-scoped kinds; cascade removes views of deleted repos |
| `filters` | JSONB | e.g. `{"types": ["bug", "debt"], "readiness": "ready"}` — shape owned per `view_kind` |
| `created_at` | DateTime(tz) | server default now |
| `updated_at` | DateTime(tz) | server default now, onupdate now |

Unique constraint `(view_kind, name)` — the sidebar never shows ambiguous duplicates; API returns 409 on conflict.

## 4. API — `backend/app/routers/views.py`

| Endpoint | Behavior |
|---|---|
| `GET /api/views` | All saved views, newest first: `id, name, view_kind, repository_id, filters, created_at` |
| `POST /api/views` | Body `{name, view_kind, repository_id, filters}`. 422 empty/whitespace name, unknown `view_kind`, or missing `repository_id` when `view_kind == "matrix"`; 409 duplicate `(view_kind, name)`; 404 unknown `repository_id` |
| `PATCH /api/views/{id}` | Rename only: body `{name}`. Same name validations; 404 unknown view |
| `DELETE /api/views/{id}` | 204. Deleting a view never touches issues |

Views are workspace-global. No GitHub writes anywhere in this slice.

## 5. Frontend

### URL params (extending existing `?repo_id=`)

- `types` — comma list: `bug,feature,debt,question,docs,unclassified` (`unclassified` ⇔ `issue_type: null`). Absent = all.
- `readiness` — one of `ready` (≥80) / `almost` (50–79) / `needswork` (<50) / `unscored` (`readiness_score: null`). Absent = any.
- Unknown/invalid values are ignored (treated as absent), never a crash.

### Filter chip row — in the existing control row of `matrix-client.tsx`

Styling per sketch findings: 8px-radius controls, accent-tint + accent-text when active, muted-but-visible when inactive (CLAUDE.md visibility rule), `all .15s ease`, all colors via theme tokens with Tailwind v4 paren syntax `bg-(--color-X)`.

- **Type chip** — dropdown with multi-select checkboxes; label `Type: All` / `Type: Bug, Debt`.
- **Readiness chip** — dropdown, single-select: Any / Ready (≥80) / Almost (50–79) / Needs work (<50) / Unscored.
- **Clear filters** — rendered only when a filter is active; resets params.
- **`N of M shown`** muted count when filters are active — hidden bubbles are never silently invisible.
- **Save view** button at the row's end, enabled only when at least one filter is active (an unfiltered view is just the Matrix nav link). Click → popover with name input → `POST /api/views` → invalidate `["views"]` → sidebar updates. 409 shown inline in the popover.

### Filtering

One pure function `applyFilters(items, filters)` in `matrix-types.ts`, applied in `matrix-client.tsx` between fetch and `toPlotted`. Chart, execution queue, and hover card all consume the same filtered set. Empty filtered result → "No issues match these filters" card + Clear-filters button (distinct from the existing "no scored issues" empty state).

### Sidebar (`sidenav.tsx`)

The Library group's "Saved Views" entry gains a dynamic sub-list: `GET /api/views` via React Query (`["views"]` key), each view a plain `<Link>` to `/plan/matrix?repo_id=…&types=…&readiness=…`, active-highlighted when the current URL matches. Count pill on "Saved Views" shows the real count. Fetch failure → static link only, never blocks navigation.

### `/views` page

Placeholder becomes a real list: name, kind badge, repository name, human-readable filter summary (e.g. "Bugs & debt · Ready"), open link, inline rename, delete with confirm. Empty state keeps the current copy.

> ⚠ Implementers MUST read `frontend/node_modules/next/dist/docs/` first — this Next.js version has breaking changes (per `frontend/AGENTS.md`).

## 6. Error handling

- View CRUD failure → inline/toast error, list refetched on settle. Plain (non-optimistic) mutations — rare, low-latency actions.
- Sidebar views fetch failing → static "Saved Views" link only; no retry storm.
- Repo deleted → its matrix views cascade-delete with it.
- Invalid URL params → ignored, treated as absent.
- Duplicate name → 409 surfaced inline in the save popover.

## 7. Testing

- **Backend (pytest):** CRUD happy paths; 422 empty name / unknown kind; 409 duplicate `(view_kind, name)`; 404 unknown repo on create; PATCH rename; cascade delete with repository; GET ordering.
- **Frontend (Playwright CLI, per CLAUDE.md):** chips filter chart + queue together (bubble count drops, `N of M shown` correct); URL round-trip (reload preserves filters); invalid params ignored; save view → appears in sidebar → click navigates and applies filters; rename + delete on `/views`; duplicate-name 409 inline; empty-filter-result state + Clear filters; theme toggle keeps chips legible in both modes.
- Full suite + lint before the PR pause.

## 8. Delivery workflow

Branch `feat/matrix-filters-views`; subagent-driven execution with house model tiering (plan steps carry complete code; haiku = transcription, sonnet = integration + every review, most-capable = final whole-branch review); `/todos start 33` at kickoff; pause before opening the PR per the PR-based review methodology.
