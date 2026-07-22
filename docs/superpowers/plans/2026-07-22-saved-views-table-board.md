# Saved Views for Table + Board Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend saved views (matrix-only since #33) to the issues table and kanban board, add matrix-style filter chips + URL-backed lane_by to the board, and reorganize the Library (sidenav + /views) into repo groups with drag reordering.

**Architecture:** Backend widens `VIEW_KINDS`, requires a repository for every kind, adds a `position` column (migration 0011) and a `PUT /views/order` bulk-reorder endpoint. Frontend replaces hardcoded matrix assumptions with a per-kind registry (`lib/views.ts`) fed by three filter codecs (`matrix-filters`, new `table-filters`, new `board-filters`), generalizes `SaveViewButton` into a shared component, and reworks `/views` + sidenav into repo-grouped lists.

**Tech Stack:** FastAPI + SQLAlchemy async + Alembic (backend), Next.js + TanStack Query + Tailwind v4 (frontend), pytest + Playwright (tests).

**Spec:** `docs/superpowers/specs/2026-07-22-saved-views-table-board-design.md`

## Global Constraints

- Branch: `feat/saved-views-table-board` (already exists, spec committed on it).
- Tailwind v4: CSS custom properties use parentheses syntax `bg-(--color-X)` — NEVER `bg-[--color-X]` brackets.
- No new dependencies. The drag reorder is hand-rolled pointer events (kanban precedent in `board-card.tsx`).
- Commit messages: no Co-Authored-By lines, no AI/model markers.
- Errors surface inline near the action (matrix pin-error precedent) — never toasts.
- Backend tests: `cd backend && python -m pytest` (needs docker compose postgres on :5432; conftest creates `issuelens_test` and runs `alembic upgrade head`, so migration 0011 is exercised automatically). Lint: `cd backend && python -m ruff check .`
- Frontend: `cd frontend && npm run lint`, `npm run build`, `npx playwright test [file]`. Before e2e: ensure no stale `issuelens-frontend-1` container is holding :3005 (`docker ps`, stop it if present).
- Keep every existing `data-testid` unless a step explicitly renames it.

---

### Task 1: Migration 0011 — `position` column on saved_views

**Files:**
- Create: `backend/alembic/versions/0011_saved_view_position.py`
- Modify: `backend/app/models.py:196-215` (SavedView class)

**Interfaces:**
- Produces: `SavedView.position: Mapped[int]` (int, not null, server default 0) — Tasks 2/3 read and write it.

- [ ] **Step 1: Write the migration**

Create `backend/alembic/versions/0011_saved_view_position.py`:

```python
"""saved view position"""

import sqlalchemy as sa
from alembic import op

revision = "0011"
down_revision = "0010"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "saved_views",
        sa.Column("position", sa.Integer(), nullable=False, server_default="0"),
    )
    # Backfill: 0..n-1 within each repository, oldest first (matches the
    # pre-position implicit ordering users saw least surprisingly).
    op.execute(
        """
        UPDATE saved_views SET position = ranked.rn
        FROM (
            SELECT id, ROW_NUMBER() OVER (
                PARTITION BY repository_id ORDER BY created_at, id
            ) - 1 AS rn
            FROM saved_views
        ) AS ranked
        WHERE saved_views.id = ranked.id
        """
    )


def downgrade() -> None:
    op.drop_column("saved_views", "position")
```

First verify `down_revision`: open `backend/alembic/versions/0010_issue_milestone_due_on.py` and confirm its `revision` value is `"0010"`; if it differs, use the actual value.

- [ ] **Step 2: Add the model column**

In `backend/app/models.py`, inside `class SavedView`, after the `filters` line (`filters: Mapped[dict] = mapped_column(JSONB, default=dict)`), add:

```python
    position: Mapped[int] = mapped_column(Integer, default=0, server_default="0")
```

`Integer` is already imported in this module (used by `SyncJob`); verify with a grep for `^from sqlalchemy import` / the existing import block and add `Integer` only if missing.

- [ ] **Step 3: Run the backend suite to verify the migration applies**

Run: `cd backend && python -m pytest tests/test_api_views.py -v`
Expected: PASS (all existing tests; conftest runs `alembic upgrade head`, which now includes 0011)

- [ ] **Step 4: Commit**

```bash
git add backend/alembic/versions/0011_saved_view_position.py backend/app/models.py
git commit -m "feat: add position column to saved_views (migration 0011)"
```

---

### Task 2: Router — widen kinds, repo required, position on create/list

**Files:**
- Modify: `backend/app/routers/views.py`
- Test: `backend/tests/test_api_views.py`

**Interfaces:**
- Consumes: `SavedView.position` from Task 1.
- Produces: `VIEW_KINDS = {"matrix", "table", "board"}`; `SavedViewOut` gains `position: int`; `GET /views` ordered by `(repository_id, position, id)`; `POST /views` 422 when `repository_id` is null (any kind) and appends `position = max+1` within the repo. Frontend Tasks 5–10 rely on `position` in responses and on table/board kinds being accepted.

- [ ] **Step 1: Update existing tests + write new failing tests**

In `backend/tests/test_api_views.py`:

Add fixtures after `MATRIX_VIEW`:

```python
TABLE_VIEW = {
    "name": "Readiness gaps",
    "view_kind": "table",
    "repository_id": 500,
    "filters": {
        "state": "open", "label": None, "assignee": None, "q": None,
        "type": "bug", "component": None, "max_readiness": "50",
        "sort": "readiness", "order": "asc",
    },
}

BOARD_VIEW = {
    "name": "By assignee",
    "view_kind": "board",
    "repository_id": 500,
    "filters": {"lane_by": "assignee", "types": ["bug"], "readiness": None},
}
```

Replace `test_create_and_list_newest_first` entirely with:

```python
async def test_create_and_list_in_position_order(client, clean_db):
    await seed_repo()
    resp = await client.post("/views", json=MATRIX_VIEW)
    assert resp.status_code == 201
    created = resp.json()
    assert created["name"] == "Ready bugs"
    assert created["view_kind"] == "matrix"
    assert created["repository_id"] == 500
    assert created["filters"] == {"types": ["bug"], "readiness": "ready"}
    assert created["position"] == 0
    assert created["id"] is not None
    assert created["created_at"] is not None

    resp2 = await client.post(
        "/views",
        json={**MATRIX_VIEW, "name": "Debt only",
              "filters": {"types": ["debt"], "readiness": None}},
    )
    assert resp2.status_code == 201
    assert resp2.json()["position"] == 1

    listed = (await client.get("/views")).json()
    assert [v["name"] for v in listed] == ["Ready bugs", "Debt only"]
    assert [v["position"] for v in listed] == [0, 1]
```

In `test_create_validation`, the matrix-without-repo case stays (still 422). Add two new tests at the end of the file:

```python
async def test_create_table_and_board_kinds(client, clean_db):
    await seed_repo()
    for body in (TABLE_VIEW, BOARD_VIEW):
        resp = await client.post("/views", json=body)
        assert resp.status_code == 201, body["view_kind"]
        assert resp.json()["view_kind"] == body["view_kind"]
        assert resp.json()["filters"] == body["filters"]


async def test_all_kinds_require_repository(client, clean_db):
    await seed_repo()
    for base in (MATRIX_VIEW, TABLE_VIEW, BOARD_VIEW):
        resp = await client.post("/views", json={**base, "repository_id": None})
        assert resp.status_code == 422, base["view_kind"]
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend && python -m pytest tests/test_api_views.py -v`
Expected: FAIL — `test_create_table_and_board_kinds` gets 422 (unknown kind), `test_create_and_list_in_position_order` has no `position` key, list order is newest-first.

- [ ] **Step 3: Implement the router changes**

In `backend/app/routers/views.py`:

Change line 5 import to include `func`:

```python
from sqlalchemy import delete, func, select
```

Change `VIEW_KINDS`:

```python
VIEW_KINDS = {"matrix", "table", "board"}
```

Add `position: int` to `SavedViewOut` (after `filters: dict`):

```python
class SavedViewOut(BaseModel):
    id: int
    name: str
    view_kind: str
    repository_id: int | None
    filters: dict
    position: int
    created_at: datetime
```

In `_to_out`, add `position=view.position,` after `filters=view.filters,`.

In `list_views`, change the `order_by` to:

```python
                select(SavedView).order_by(
                    SavedView.repository_id, SavedView.position, SavedView.id
                )
```

In `create_view`, replace the matrix-specific repo check (the `if body.view_kind == "matrix" and body.repository_id is None:` block) with:

```python
    if body.repository_id is None:
        raise HTTPException(status_code=422, detail="Views require a repository")
```

The existing repo-existence check (`if body.repository_id is not None:`) can now drop its condition — `repository_id` is always set past this point; keep the body, remove the `if body.repository_id is not None:` wrapper (dedent).

Before constructing `view = SavedView(...)`, compute the append position:

```python
    max_position = (
        await session.execute(
            select(func.max(SavedView.position)).where(
                SavedView.repository_id == body.repository_id
            )
        )
    ).scalar_one()
    view = SavedView(
        name=name,
        view_kind=body.view_kind,
        repository_id=body.repository_id,
        filters=body.filters,
        position=0 if max_position is None else max_position + 1,
    )
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd backend && python -m pytest tests/test_api_views.py -v`
Expected: PASS (all)

- [ ] **Step 5: Ruff + commit**

Run: `cd backend && python -m ruff check .`

```bash
git add backend/app/routers/views.py backend/tests/test_api_views.py
git commit -m "feat: accept table/board view kinds, require repo, position ordering"
```

---

### Task 3: `PUT /views/order` reorder endpoint

**Files:**
- Modify: `backend/app/routers/views.py`
- Test: `backend/tests/test_api_views.py`

**Interfaces:**
- Consumes: `SavedView.position`, `_to_out`, `SavedViewOut` from Task 2.
- Produces: `PUT /views/order` with body `{"repository_id": int, "ordered_ids": [int]}` → 200 with the repo's views as `list[SavedViewOut]` in new order; 404 unknown repo; 422 when `ordered_ids` is not exactly the set of that repo's view ids (missing, foreign, or duplicate ids). Frontend `reorderViews()` (Task 5) calls this.

- [ ] **Step 1: Write failing tests**

Append to `backend/tests/test_api_views.py`:

```python
async def seed_second_repo() -> None:
    async with get_sessionmaker()() as session:
        session.add(
            Repository(id=600, installation_id=42, full_name="patelmj/issuelens",
                       owner="patelmj", name="issuelens")
        )
        await session.commit()


async def test_reorder_views(client, clean_db):
    await seed_repo()
    ids = []
    for view_name in ("A", "B", "C"):
        resp = await client.post("/views", json={**MATRIX_VIEW, "name": view_name})
        ids.append(resp.json()["id"])

    resp = await client.put(
        "/views/order", json={"repository_id": 500, "ordered_ids": ids[::-1]}
    )
    assert resp.status_code == 200
    assert [v["name"] for v in resp.json()] == ["C", "B", "A"]
    assert [v["position"] for v in resp.json()] == [0, 1, 2]

    listed = (await client.get("/views")).json()
    assert [v["name"] for v in listed] == ["C", "B", "A"]


async def test_reorder_validation(client, clean_db):
    await seed_repo()
    await seed_second_repo()
    v1 = (await client.post("/views", json=MATRIX_VIEW)).json()
    v2 = (await client.post("/views", json={**MATRIX_VIEW, "name": "Other"})).json()
    foreign = (
        await client.post(
            "/views", json={**MATRIX_VIEW, "name": "Foreign", "repository_id": 600}
        )
    ).json()

    # unknown repository
    resp = await client.put(
        "/views/order", json={"repository_id": 999, "ordered_ids": [1]}
    )
    assert resp.status_code == 404
    # missing an id
    resp = await client.put(
        "/views/order", json={"repository_id": 500, "ordered_ids": [v1["id"]]}
    )
    assert resp.status_code == 422
    # id belonging to another repo
    resp = await client.put(
        "/views/order",
        json={"repository_id": 500,
              "ordered_ids": [v1["id"], v2["id"], foreign["id"]]},
    )
    assert resp.status_code == 422
    # duplicate ids
    resp = await client.put(
        "/views/order",
        json={"repository_id": 500, "ordered_ids": [v1["id"], v1["id"]]},
    )
    assert resp.status_code == 422


async def test_reorder_leaves_other_repos_untouched(client, clean_db):
    await seed_repo()
    await seed_second_repo()
    a = (await client.post("/views", json=MATRIX_VIEW)).json()
    b = (await client.post("/views", json={**MATRIX_VIEW, "name": "Second"})).json()
    other = (
        await client.post(
            "/views", json={**MATRIX_VIEW, "name": "Elsewhere", "repository_id": 600}
        )
    ).json()

    resp = await client.put(
        "/views/order",
        json={"repository_id": 500, "ordered_ids": [b["id"], a["id"]]},
    )
    assert resp.status_code == 200

    listed = (await client.get("/views")).json()
    by_id = {v["id"]: v for v in listed}
    assert by_id[other["id"]]["position"] == 0
    assert by_id[b["id"]]["position"] == 0
    assert by_id[a["id"]]["position"] == 1
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend && python -m pytest tests/test_api_views.py -v -k reorder`
Expected: FAIL with 404/405 (route does not exist)

- [ ] **Step 3: Implement the endpoint**

In `backend/app/routers/views.py`, add after `RenameIn`:

```python
class OrderIn(BaseModel):
    repository_id: int
    ordered_ids: list[int]
```

Add the endpoint after `list_views` (before `create_view` for readability; FastAPI method+path routing has no conflict with `/views/{view_id}` since that path has no PUT):

```python
@router.put("/views/order", response_model=list[SavedViewOut])
async def reorder_views(
    body: OrderIn, session: AsyncSession = Depends(get_session)
) -> list[SavedViewOut]:
    repo = (
        await session.execute(
            select(Repository).where(Repository.id == body.repository_id)
        )
    ).scalar_one_or_none()
    if repo is None:
        raise HTTPException(status_code=404, detail="Unknown repository")
    views = (
        (
            await session.execute(
                select(SavedView).where(
                    SavedView.repository_id == body.repository_id
                )
            )
        )
        .scalars()
        .all()
    )
    if len(body.ordered_ids) != len(set(body.ordered_ids)) or set(
        body.ordered_ids
    ) != {view.id for view in views}:
        raise HTTPException(
            status_code=422,
            detail="ordered_ids must be exactly this repository's view ids",
        )
    new_position = {view_id: index for index, view_id in enumerate(body.ordered_ids)}
    for view in views:
        view.position = new_position[view.id]
    await session.commit()
    return [_to_out(view) for view in sorted(views, key=lambda v: v.position)]
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd backend && python -m pytest tests/test_api_views.py -v`
Expected: PASS (all)

- [ ] **Step 5: Ruff + commit**

Run: `cd backend && python -m ruff check .`

```bash
git add backend/app/routers/views.py backend/tests/test_api_views.py
git commit -m "feat: PUT /views/order bulk reorder within a repository"
```

---

### Task 4: Filter codecs — `table-filters.ts` + `board-filters.ts`

**Files:**
- Modify: `frontend/src/lib/matrix-filters.ts:39` (export `ParamSource`)
- Create: `frontend/src/lib/table-filters.ts`
- Create: `frontend/src/lib/board-filters.ts`

**Interfaces:**
- Produces (table): `TableViewFilters`, `TABLE_DEFAULTS`, `parseTableFilters(params)`, `tableFiltersToSearch(repoId, f)`, `tableFiltersFromJson(value)`, `hasActiveTableFilters(f)`, `tableFilterSummary(f)`.
- Produces (board): `BoardViewFilters` (= `MatrixFilters & { lane_by: "none"|"component"|"assignee" }`), `parseBoardFilters(params)`, `boardFiltersToSearch(repoId, f)`, `boardFiltersFromJson(value)`, `hasActiveBoardFilters(f)`, `boardFilterSummary(f)`.
- Tasks 5–10 consume these exact names.

- [ ] **Step 1: Export ParamSource**

In `frontend/src/lib/matrix-filters.ts` line 39, change:

```ts
type ParamSource = { get(name: string): string | null };
```

to:

```ts
export type ParamSource = { get(name: string): string | null };
```

- [ ] **Step 2: Create `frontend/src/lib/table-filters.ts`**

```ts
import type { ParamSource } from "./matrix-filters";

export const TABLE_STATES = ["open", "closed", "all"] as const;
export type TableState = (typeof TABLE_STATES)[number];

export const TABLE_SORTS = [
  "updated",
  "created",
  "comments",
  "number",
  "title",
  "readiness",
] as const;
export type TableSort = (typeof TABLE_SORTS)[number];

/** Values offered by the table toolbar; anything else is dropped on parse. */
export const TABLE_TYPES = ["bug", "feature", "debt", "question", "docs"] as const;
export const TABLE_READINESS_THRESHOLDS = ["90", "75", "50", "25"] as const;

export type TableViewFilters = {
  state: TableState;
  label: string | null;
  assignee: string | null;
  q: string | null;
  type: string | null;
  component: string | null;
  max_readiness: string | null;
  sort: TableSort;
  order: "asc" | "desc";
};

export const TABLE_DEFAULTS: TableViewFilters = {
  state: "open",
  label: null,
  assignee: null,
  q: null,
  type: null,
  component: null,
  max_readiness: null,
  sort: "updated",
  order: "desc",
};

function cleanString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function oneOf<T extends string>(
  value: unknown,
  allowed: readonly T[],
  fallback: T,
): T {
  return typeof value === "string" && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : fallback;
}

function memberOrNull(value: unknown, allowed: readonly string[]): string | null {
  return typeof value === "string" && allowed.includes(value) ? value : null;
}

/** Unknown or malformed values fall back to defaults — never a crash. */
export function parseTableFilters(params: ParamSource): TableViewFilters {
  return {
    state: oneOf(params.get("state"), TABLE_STATES, "open"),
    label: cleanString(params.get("label")),
    assignee: cleanString(params.get("assignee")),
    q: cleanString(params.get("q")),
    type: memberOrNull(params.get("type"), TABLE_TYPES),
    component: cleanString(params.get("component")),
    max_readiness: memberOrNull(
      params.get("max_readiness"),
      TABLE_READINESS_THRESHOLDS,
    ),
    sort: oneOf(params.get("sort"), TABLE_SORTS, "updated"),
    order: oneOf(params.get("order"), ["asc", "desc"] as const, "desc"),
  };
}

/** Canonical query string — only non-default values, stable key order. */
export function tableFiltersToSearch(
  repoId: number | null,
  f: TableViewFilters,
): string {
  const params = new URLSearchParams();
  if (repoId != null) params.set("repo_id", String(repoId));
  if (f.state !== "open") params.set("state", f.state);
  if (f.q) params.set("q", f.q);
  if (f.label) params.set("label", f.label);
  if (f.assignee) params.set("assignee", f.assignee);
  if (f.type) params.set("type", f.type);
  if (f.component) params.set("component", f.component);
  if (f.max_readiness) params.set("max_readiness", f.max_readiness);
  if (f.sort !== "updated") params.set("sort", f.sort);
  if (f.order !== "desc") params.set("order", f.order);
  return params.toString();
}

/** Sanitize a saved view's JSONB filters payload (untrusted shape). */
export function tableFiltersFromJson(value: unknown): TableViewFilters {
  const obj = (typeof value === "object" && value !== null ? value : {}) as Record<
    string,
    unknown
  >;
  return {
    state: oneOf(obj.state, TABLE_STATES, "open"),
    label: cleanString(obj.label),
    assignee: cleanString(obj.assignee),
    q: cleanString(obj.q),
    type: memberOrNull(obj.type, TABLE_TYPES),
    component: cleanString(obj.component),
    max_readiness: memberOrNull(obj.max_readiness, TABLE_READINESS_THRESHOLDS),
    sort: oneOf(obj.sort, TABLE_SORTS, "updated"),
    order: oneOf(obj.order, ["asc", "desc"] as const, "desc"),
  };
}

export function hasActiveTableFilters(f: TableViewFilters): boolean {
  return (Object.keys(TABLE_DEFAULTS) as (keyof TableViewFilters)[]).some(
    (key) => f[key] !== TABLE_DEFAULTS[key],
  );
}

const STATE_LABEL: Record<TableState, string> = {
  open: "Open",
  closed: "Closed",
  all: "All states",
};

/** Human-readable summary, e.g. "Open · bug · readiness <50% · by readiness ↑". */
export function tableFilterSummary(f: TableViewFilters): string {
  const parts: string[] = [STATE_LABEL[f.state]];
  if (f.q) parts.push(`"${f.q}"`);
  if (f.type) parts.push(f.type);
  if (f.component) parts.push(f.component);
  if (f.label) parts.push(f.label);
  if (f.assignee) parts.push(`@${f.assignee}`);
  if (f.max_readiness) parts.push(`readiness <${f.max_readiness}%`);
  if (f.sort !== "updated" || f.order !== "desc") {
    parts.push(`by ${f.sort} ${f.order === "asc" ? "↑" : "↓"}`);
  }
  return parts.join(" · ");
}
```

- [ ] **Step 3: Create `frontend/src/lib/board-filters.ts`**

```ts
import {
  filterSummary,
  filtersFromJson,
  filtersToSearch,
  hasActiveFilters,
  parseFilters,
  type MatrixFilters,
  type ParamSource,
} from "./matrix-filters";

export const LANE_BY_VALUES = ["none", "component", "assignee"] as const;
export type BoardLaneBy = (typeof LANE_BY_VALUES)[number];

export type BoardViewFilters = MatrixFilters & { lane_by: BoardLaneBy };

function laneByOf(value: unknown): BoardLaneBy {
  return typeof value === "string" &&
    (LANE_BY_VALUES as readonly string[]).includes(value)
    ? (value as BoardLaneBy)
    : "none";
}

export function parseBoardFilters(params: ParamSource): BoardViewFilters {
  return { ...parseFilters(params), lane_by: laneByOf(params.get("lane_by")) };
}

export function boardFiltersToSearch(
  repoId: number | null,
  f: BoardViewFilters,
): string {
  const params = new URLSearchParams(filtersToSearch(repoId, f));
  if (f.lane_by !== "none") params.set("lane_by", f.lane_by);
  return params.toString();
}

/** Sanitize a saved view's JSONB filters payload (untrusted shape). */
export function boardFiltersFromJson(value: unknown): BoardViewFilters {
  const obj = (typeof value === "object" && value !== null ? value : {}) as {
    lane_by?: unknown;
  };
  return { ...filtersFromJson(value), lane_by: laneByOf(obj.lane_by) };
}

export function hasActiveBoardFilters(f: BoardViewFilters): boolean {
  return f.lane_by !== "none" || hasActiveFilters(f);
}

/** e.g. "Laned by assignee · Bug, Debt · Ready (≥80)". */
export function boardFilterSummary(f: BoardViewFilters): string {
  const parts: string[] = [];
  if (f.lane_by !== "none") parts.push(`Laned by ${f.lane_by}`);
  if (hasActiveFilters(f)) parts.push(filterSummary(f));
  return parts.length ? parts.join(" · ") : "Default board";
}
```

- [ ] **Step 4: Lint + build**

Run: `cd frontend && npm run lint && npm run build`
Expected: clean

- [ ] **Step 5: Commit**

```bash
git add frontend/src/lib/matrix-filters.ts frontend/src/lib/table-filters.ts frontend/src/lib/board-filters.ts
git commit -m "feat: table and board filter codecs (parse/serialize/sanitize/summary)"
```

---

### Task 5: Kind registry in `lib/views.ts` + reorder API helper

**Files:**
- Modify: `frontend/src/lib/views.ts` (full rewrite below)
- Modify: `frontend/src/components/sidenav.tsx:109-126` (minimal null-href handling)
- Modify: `frontend/src/app/views/views-client.tsx:151-157` (minimal null-href handling)

**Interfaces:**
- Consumes: codecs from Task 4.
- Produces: `SavedView` type gains `position: number`; `savedViewHref(view): string | null` (null = unknown kind, render inert); `savedViewKindLabel(view): string`; `savedViewSummary(view): string`; `reorderViews(repositoryId, orderedIds): Promise<SavedView[]>`. Tasks 7–10 consume these exact names.

- [ ] **Step 1: Rewrite `frontend/src/lib/views.ts`**

```ts
import { getJson, sendJson } from "./api";
import {
  filterSummary,
  filtersFromJson,
  filtersToSearch,
} from "./matrix-filters";
import {
  tableFilterSummary,
  tableFiltersFromJson,
  tableFiltersToSearch,
} from "./table-filters";
import {
  boardFilterSummary,
  boardFiltersFromJson,
  boardFiltersToSearch,
} from "./board-filters";

export type SavedView = {
  id: number;
  name: string;
  view_kind: string;
  repository_id: number | null;
  filters: unknown;
  position: number;
  created_at: string;
};

export const VIEWS_KEY = ["views"] as const;

export function fetchViews(): Promise<SavedView[]> {
  return getJson<SavedView[]>("/api/backend/views");
}

type KindMeta = {
  label: string;
  href: (view: SavedView) => string;
  summary: (view: SavedView) => string;
};

const withSearch = (route: string, search: string) =>
  search ? `${route}?${search}` : route;

const VIEW_KIND_META: Record<string, KindMeta> = {
  matrix: {
    label: "Matrix",
    href: (view) =>
      withSearch(
        "/plan/matrix",
        filtersToSearch(view.repository_id, filtersFromJson(view.filters)),
      ),
    summary: (view) => filterSummary(filtersFromJson(view.filters)),
  },
  table: {
    label: "Table",
    href: (view) =>
      withSearch(
        "/plan",
        tableFiltersToSearch(view.repository_id, tableFiltersFromJson(view.filters)),
      ),
    summary: (view) => tableFilterSummary(tableFiltersFromJson(view.filters)),
  },
  board: {
    label: "Board",
    href: (view) =>
      withSearch(
        "/plan/board",
        boardFiltersToSearch(view.repository_id, boardFiltersFromJson(view.filters)),
      ),
    summary: (view) => boardFilterSummary(boardFiltersFromJson(view.filters)),
  },
};

/** Deep link that re-applies a view's repo + filters; null for unknown kinds. */
export function savedViewHref(view: SavedView): string | null {
  return VIEW_KIND_META[view.view_kind]?.href(view) ?? null;
}

export function savedViewKindLabel(view: SavedView): string {
  return VIEW_KIND_META[view.view_kind]?.label ?? view.view_kind;
}

export function savedViewSummary(view: SavedView): string {
  return VIEW_KIND_META[view.view_kind]?.summary(view) ?? "—";
}

export function reorderViews(
  repositoryId: number,
  orderedIds: number[],
): Promise<SavedView[]> {
  return sendJson<SavedView[]>("/api/backend/views/order", "PUT", {
    repository_id: repositoryId,
    ordered_ids: orderedIds,
  });
}
```

- [ ] **Step 2: Patch the two call sites for the nullable href**

These are minimal compile fixes; Tasks 9 and 10 rework both files fully.

In `frontend/src/components/sidenav.tsx`, inside `matrixViews.map((view) => {`, change:

```tsx
                        const viewHref = savedViewHref(view);
```

to:

```tsx
                        const viewHref = savedViewHref(view);
                        if (viewHref == null) return null;
```

In `frontend/src/app/views/views-client.tsx`, the row's `<Link href={savedViewHref(view)} ...>` — wrap it. Replace:

```tsx
              <Link
                href={savedViewHref(view)}
                data-testid={`view-open-${view.id}`}
                className="rounded-lg border border-(--color-border) px-2.5 py-1 text-(--color-primary) transition-all duration-150 hover:bg-(--accent-tint)"
              >
                Open
              </Link>
```

with:

```tsx
              {savedViewHref(view) != null ? (
                <Link
                  href={savedViewHref(view)!}
                  data-testid={`view-open-${view.id}`}
                  className="rounded-lg border border-(--color-border) px-2.5 py-1 text-(--color-primary) transition-all duration-150 hover:bg-(--accent-tint)"
                >
                  Open
                </Link>
              ) : null}
```

- [ ] **Step 3: Verify existing behavior is unchanged**

Run: `cd frontend && npm run lint && npm run build`
Expected: clean

Run: `cd frontend && npx playwright test e2e/views.spec.ts e2e/save-view.spec.ts e2e/saved-views-nav.spec.ts`
Expected: PASS (stubs lack `position`, but nothing reads it yet)

- [ ] **Step 4: Commit**

```bash
git add frontend/src/lib/views.ts frontend/src/components/sidenav.tsx frontend/src/app/views/views-client.tsx
git commit -m "feat: per-kind saved-view registry with kind-aware hrefs and summaries"
```

---

### Task 6: Shared FilterChips + shared SaveViewButton

**Files:**
- Create: `frontend/src/components/filter-chips.tsx` (moved from `frontend/src/app/plan/matrix/filter-chips.tsx`)
- Delete: `frontend/src/app/plan/matrix/filter-chips.tsx`
- Create: `frontend/src/components/save-view.tsx` (generalized from `frontend/src/app/plan/matrix/save-view.tsx`)
- Delete: `frontend/src/app/plan/matrix/save-view.tsx`
- Modify: `frontend/src/app/plan/matrix/matrix-client.tsx:24-25,178`

**Interfaces:**
- Produces: `FilterChips({ filters: MatrixFilters, onChange })` at `components/filter-chips` (unchanged API, new home); `SaveViewButton({ viewKind: string, repositoryId: number | null, filters: Record<string, unknown>, canSave: boolean })` at `components/save-view`. Tasks 7 and 8 mount these on board and table.

- [ ] **Step 1: Move FilterChips**

`git mv frontend/src/app/plan/matrix/filter-chips.tsx frontend/src/components/filter-chips.tsx`, then fix its import path: change `from "../../../lib/matrix-filters"` to `from "../lib/matrix-filters"`. No other content changes.

- [ ] **Step 2: Create the shared SaveViewButton**

Create `frontend/src/components/save-view.tsx` with the full content of the old `frontend/src/app/plan/matrix/save-view.tsx`, with these changes — new props/signature and POST body (imports drop `matrix-filters`, paths go up one level less):

```tsx
"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { sendJson } from "../lib/api";
import { VIEWS_KEY, type SavedView } from "../lib/views";

const panel =
  "absolute right-0 top-full z-30 mt-1 flex w-60 flex-col gap-2 rounded-lg border border-(--color-border) bg-(--color-surface) p-2.5 shadow-(--shadow-card)";

export function SaveViewButton({
  viewKind,
  repositoryId,
  filters,
  canSave,
}: {
  viewKind: string;
  repositoryId: number | null;
  /** Kind-specific snapshot persisted verbatim as the view's JSONB filters. */
  filters: Record<string, unknown>;
  canSave: boolean;
}) {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const rootRef = useRef<HTMLDivElement>(null);

  const mutation = useMutation({
    mutationFn: () =>
      sendJson<SavedView>("/api/backend/views", "POST", {
        name: name.trim(),
        view_kind: viewKind,
        repository_id: repositoryId,
        filters,
      }),
    onSuccess: () => {
      setOpen(false);
      setName("");
      queryClient.invalidateQueries({ queryKey: VIEWS_KEY });
    },
  });

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        data-testid="save-view"
        disabled={!canSave}
        className="rounded-lg border border-(--color-border) bg-(--color-surface) px-2.5 py-1.5 text-(--color-primary) transition-all duration-150 enabled:hover:bg-(--accent-tint) disabled:text-(--color-text-muted) disabled:opacity-60"
        onClick={() => {
          mutation.reset();
          setOpen(!open);
        }}
      >
        Save view
      </button>
      {open ? (
        <form
          data-testid="save-view-popover"
          className={panel}
          onSubmit={(e) => {
            e.preventDefault();
            if (name.trim() && !mutation.isPending) mutation.mutate();
          }}
        >
          <input
            autoFocus
            data-testid="save-view-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="View name"
            aria-label="View name"
            className="rounded-lg border border-(--color-border) bg-(--color-bg) px-2.5 py-1.5"
          />
          <button
            type="submit"
            data-testid="save-view-submit"
            disabled={!name.trim() || mutation.isPending}
            className="rounded-lg bg-(--accent-tint) px-2.5 py-1.5 font-medium text-(--color-primary) transition-all duration-150 disabled:opacity-60"
          >
            {mutation.isPending ? "Saving…" : "Save"}
          </button>
          {mutation.isError ? (
            <div data-testid="save-view-error" className="text-(--color-danger)">
              {mutation.error.message}
            </div>
          ) : null}
        </form>
      ) : null}
    </div>
  );
}
```

Delete `frontend/src/app/plan/matrix/save-view.tsx`.

- [ ] **Step 3: Rewire matrix-client**

In `frontend/src/app/plan/matrix/matrix-client.tsx`:

Change the two imports (lines 24-25):

```tsx
import { FilterChips } from "../../../components/filter-chips";
import { SaveViewButton } from "../../../components/save-view";
```

Change the usage (line 178):

```tsx
        <SaveViewButton
          viewKind="matrix"
          repositoryId={repoId}
          canSave={repoId != null && hasActiveFilters(filters)}
          filters={{ types: filters.types, readiness: filters.readiness }}
        />
```

- [ ] **Step 4: Verify matrix flows unchanged**

Run: `cd frontend && npm run lint && npm run build`
Run: `cd frontend && npx playwright test e2e/save-view.spec.ts e2e/matrix-filters.spec.ts`
Expected: PASS — the POST body and all testids are byte-identical to before.

- [ ] **Step 5: Commit**

```bash
git add -A frontend/src/components frontend/src/app/plan/matrix
git commit -m "refactor: shared FilterChips and kind-agnostic SaveViewButton"
```

---

### Task 7: Board surface — URL lane_by, filter chips, save button

**Files:**
- Modify: `frontend/src/app/plan/board/board-client.tsx` (full rewrite below)
- Test (new): `frontend/e2e/board-filters.spec.ts`

**Interfaces:**
- Consumes: `parseBoardFilters`/`boardFiltersToSearch`/`hasActiveBoardFilters`/`BoardViewFilters` (Task 4), `FilterChips`/`SaveViewButton` (Task 6), `matchesFilters`/`hasActiveFilters` from `matrix-filters`.
- Produces: board URL state `repo_id`, `lane_by`, `types`, `readiness`; testid `board-filter-count`. Saved board views POST `filters: { lane_by, types, readiness }`.

- [ ] **Step 1: Write the failing e2e spec**

Create `frontend/e2e/board-filters.spec.ts`:

```ts
import { expect, test, type Page, type Route } from "@playwright/test";

const card = (over: Partial<Record<string, unknown>> = {}) => ({
  issue_id: 1,
  number: 42,
  title: "Fix token refresh",
  component: "auth",
  issue_type: "bug",
  priority_band: "dofirst",
  readiness_pct: 80,
  estimate: 3,
  assignees: ["alice"],
  gh_updated_at: "2026-07-20T00:00:00Z",
  warning: null,
  placed: false,
  ...over,
});

const payload = {
  columns: [
    { key: "needs_detail", cards: [] },
    {
      key: "ready",
      cards: [
        card(),
        card({
          issue_id: 2,
          number: 43,
          title: "Docs typo",
          issue_type: "docs",
          readiness_pct: 30,
          component: "docs",
          assignees: [],
        }),
      ],
    },
    { key: "in_progress", cards: [] },
    { key: "review", cards: [] },
    { key: "blocked", cards: [] },
    { key: "done", cards: [] },
  ],
  total: 2,
};

async function stubBoard(page: Page, posts: unknown[] = []) {
  await page.route(/\/api\/backend\/repositories$/, (route: Route) =>
    route.fulfill({ json: [{ id: 500, full_name: "patelmj/mehova" }] }),
  );
  await page.route(/\/api\/backend\/repositories\/500\/kanban$/, (route: Route) =>
    route.fulfill({ json: payload }),
  );
  await page.route(/\/api\/backend\/views$/, (route: Route) => {
    if (route.request().method() === "POST") {
      posts.push(route.request().postDataJSON());
      return route.fulfill({
        status: 201,
        json: {
          id: 1,
          position: 0,
          created_at: "2026-07-22T00:00:00Z",
          ...(route.request().postDataJSON() as object),
        },
      });
    }
    return route.fulfill({ json: [] });
  });
}

test("type chip filters cards and shows the shown-count", async ({ page }) => {
  await stubBoard(page);
  await page.goto("/plan/board?repo_id=500");
  await expect(page.getByTestId("card-42")).toBeVisible();
  await expect(page.getByTestId("card-43")).toBeVisible();

  await page.getByTestId("type-chip").click();
  await page.getByTestId("type-panel").getByLabel("Bug").check();
  await expect(page).toHaveURL(/types=bug/);
  await expect(page.getByTestId("card-42")).toBeVisible();
  await expect(page.getByTestId("card-43")).not.toBeVisible();
  await expect(page.getByTestId("board-filter-count")).toHaveText("1 of 2 shown");
});

test("lane_by round-trips through the URL", async ({ page }) => {
  await stubBoard(page);
  await page.goto("/plan/board?repo_id=500");
  await page.getByTestId("lane-by").getByRole("button", { name: "Assignee" }).click();
  await expect(page).toHaveURL(/lane_by=assignee/);
  await expect(page.getByTestId("swimlane-alice")).toBeVisible();

  await page.reload();
  await expect(
    page.getByTestId("lane-by").getByRole("button", { name: "Assignee" }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("swimlane-alice")).toBeVisible();
});

test("save is disabled at defaults, posts board snapshot when active", async ({
  page,
}) => {
  const posts: unknown[] = [];
  await stubBoard(page, posts);
  await page.goto("/plan/board?repo_id=500");
  await expect(page.getByTestId("save-view")).toBeDisabled();

  await page.goto("/plan/board?repo_id=500&types=bug&lane_by=assignee");
  await expect(page.getByTestId("save-view")).toBeEnabled();
  await page.getByTestId("save-view").click();
  await page.getByTestId("save-view-name").fill("Bug lanes");
  await page.getByTestId("save-view-submit").click();

  await expect.poll(() => posts.length).toBe(1);
  expect(posts[0]).toEqual({
    name: "Bug lanes",
    view_kind: "board",
    repository_id: 500,
    filters: { lane_by: "assignee", types: ["bug"], readiness: null },
  });
});
```

Note the `type-panel` checkbox: `FilterChips` renders `<label>` with an `<input type="checkbox">` and a `<span>Bug</span>` — `getByLabel("Bug")` resolves it. If it does not, use `page.getByTestId("type-panel").locator("label", { hasText: "Bug" }).locator("input")` instead.

- [ ] **Step 2: Run the spec to verify it fails**

Run: `cd frontend && npx playwright test e2e/board-filters.spec.ts`
Expected: FAIL (no chips, no lane_by URL param, no save button on the board)

- [ ] **Step 3: Rewrite board-client.tsx**

Replace the full contents of `frontend/src/app/plan/board/board-client.tsx` with:

```tsx
"use client";

import {
  keepPreviousData,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useState } from "react";
import { getJson, sendJson } from "../../../lib/api";
import {
  boardFiltersToSearch,
  hasActiveBoardFilters,
  parseBoardFilters,
  type BoardViewFilters,
} from "../../../lib/board-filters";
import { hasActiveFilters, matchesFilters } from "../../../lib/matrix-filters";
import { FilterChips } from "../../../components/filter-chips";
import { SaveViewButton } from "../../../components/save-view";
import { PlanTabs } from "../plan-tabs";
import { BoardCard } from "./board-card";
import {
  COLUMN_LABEL,
  lanesFor,
  movedPayload,
  type KanbanPayload,
  type WorkflowColumn,
} from "./board-types";

const card =
  "rounded-[14px] border border-(--color-border) bg-(--color-surface) shadow-(--shadow-card)";

type Repo = { id: number; full_name: string };

export function BoardClient() {
  const searchParams = useSearchParams();
  const router = useRouter();

  const { data: repos, isPending: reposPending } = useQuery({
    queryKey: ["repositories"],
    queryFn: () => getJson<Repo[]>("/api/backend/repositories"),
  });

  const repoParam = searchParams.get("repo_id");
  const repoId = repoParam ? Number(repoParam) : (repos?.[0]?.id ?? null);
  const kanbanKey = ["kanban", repoId] as const;

  const boardFilters = parseBoardFilters(searchParams);
  const laneBy = boardFilters.lane_by;

  const navigateWith = useCallback(
    (nextRepoId: number | null, next: BoardViewFilters) => {
      const search = boardFiltersToSearch(nextRepoId, next);
      router.replace(search ? `/plan/board?${search}` : "/plan/board", {
        scroll: false,
      });
    },
    [router],
  );

  const { data, error, isPending } = useQuery({
    queryKey: kanbanKey,
    queryFn: () => getJson<KanbanPayload>(`/api/backend/repositories/${repoId}/kanban`),
    enabled: repoId != null,
    placeholderData: keepPreviousData,
  });

  const queryClient = useQueryClient();
  const [dropTarget, setDropTarget] = useState<WorkflowColumn | null>(null);
  const [moveError, setMoveError] = useState<string | null>(null);

  const moveMutation = useMutation({
    mutationFn: ({ issueId, column }: { issueId: number; column: WorkflowColumn }) =>
      sendJson<{ issue_id: number }>(`/api/backend/issues/${issueId}/workflow`, "PUT", {
        column,
      }),
    onMutate: async ({ issueId, column }) => {
      await queryClient.cancelQueries({ queryKey: kanbanKey });
      const previous = queryClient.getQueryData<KanbanPayload>(kanbanKey);
      queryClient.setQueryData<KanbanPayload>(kanbanKey, (old) =>
        old ? movedPayload(old, issueId, column) : old,
      );
      setMoveError(null);
      return { previous };
    },
    onError: (err, _vars, context) => {
      if (context?.previous) queryClient.setQueryData(kanbanKey, context.previous);
      setMoveError(err.message);
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: kanbanKey }),
  });

  const resetMutation = useMutation({
    mutationFn: (issueId: number) =>
      sendJson<undefined>(`/api/backend/issues/${issueId}/workflow`, "DELETE"),
    onMutate: async () => {
      await queryClient.cancelQueries({ queryKey: kanbanKey });
      setMoveError(null);
      return { previous: queryClient.getQueryData<KanbanPayload>(kanbanKey) };
    },
    onError: (err, _vars, context) => {
      if (context?.previous) queryClient.setQueryData(kanbanKey, context.previous);
      setMoveError(err.message);
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: kanbanKey }),
  });

  // Chips filter client-side; the kanban cache always holds the full payload,
  // so optimistic move/reset updates stay filter-agnostic.
  const chipsActive = hasActiveFilters(boardFilters);
  const filteredData =
    data && chipsActive
      ? {
          ...data,
          columns: data.columns.map((col) => ({
            ...col,
            cards: col.cards.filter((c) =>
              matchesFilters(
                { issue_type: c.issue_type, readiness_score: c.readiness_pct },
                boardFilters,
              ),
            ),
          })),
        }
      : data;
  const shownCount =
    filteredData?.columns.reduce((n, col) => n + col.cards.length, 0) ?? 0;
  const lanes = filteredData ? lanesFor(filteredData, laneBy) : [];

  return (
    <div className="flex flex-col gap-4" data-testid="board-content">
      <div className="flex items-baseline gap-3">
        <h1 className="text-lg font-semibold tracking-[-0.01em]">Plan</h1>
        <span className="text-(--color-text-muted)">
          Workflow board — drag a card to move it
        </span>
        <div className="grow" />
        <PlanTabs />
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <select
          aria-label="Repository"
          className="rounded-lg border border-(--color-border) bg-(--color-surface) px-2.5 py-1.5"
          value={repoId ?? ""}
          onChange={(e) =>
            navigateWith(e.target.value ? Number(e.target.value) : null, boardFilters)
          }
        >
          {(repos ?? []).map((repo) => (
            <option key={repo.id} value={repo.id}>
              {repo.full_name}
            </option>
          ))}
        </select>
        <div
          className="flex items-center gap-0.5 rounded-[9px] border border-(--color-border) bg-(--color-surface) p-0.5"
          data-testid="lane-by"
        >
          {(
            [
              ["none", "None"],
              ["component", "Component"],
              ["assignee", "Assignee"],
            ] as const
          ).map(([value, label]) => (
            <button
              key={value}
              type="button"
              aria-pressed={laneBy === value}
              className={`rounded-[7px] px-2.5 py-1 transition-all duration-150 ${
                laneBy === value
                  ? "bg-(--accent-tint) font-medium text-(--color-primary)"
                  : "text-(--color-text-muted) hover:text-(--color-text)"
              }`}
              onClick={() => navigateWith(repoId, { ...boardFilters, lane_by: value })}
            >
              {label}
            </button>
          ))}
        </div>
        <FilterChips
          filters={{ types: boardFilters.types, readiness: boardFilters.readiness }}
          onChange={(next) => navigateWith(repoId, { ...next, lane_by: laneBy })}
        />
        {chipsActive && data ? (
          <span className="text-(--color-text-muted)" data-testid="board-filter-count">
            {shownCount} of {data.total} shown
          </span>
        ) : null}
        <SaveViewButton
          viewKind="board"
          repositoryId={repoId}
          canSave={repoId != null && hasActiveBoardFilters(boardFilters)}
          filters={{
            lane_by: boardFilters.lane_by,
            types: boardFilters.types,
            readiness: boardFilters.readiness,
          }}
        />
        {moveError ? (
          <span className="text-(--color-danger)" data-testid="move-error">
            {moveError}
          </span>
        ) : null}
      </div>

      {reposPending || (repoId != null && isPending) ? (
        <div className={`${card} px-6 py-16 text-center text-(--color-text-muted)`}>
          Loading board…
        </div>
      ) : error ? (
        <div className={`${card} px-6 py-16 text-center`}>
          <div className="text-sm font-medium">Backend unavailable</div>
          <div className="pt-1.5 text-(--color-text-muted)">{error.message}</div>
        </div>
      ) : repos && repos.length === 0 ? (
        <div className={`${card} flex flex-col items-center gap-1.5 px-6 py-16 text-center`}>
          <div className="text-sm font-medium">No repositories connected</div>
          <div className="max-w-md text-(--color-text-muted)">
            Install the IssueLens GitHub App and sync a repository to see its
            issues here.
          </div>
          <Link className="pt-2 text-(--color-primary) hover:underline" href="/repositories">
            Go to Repositories →
          </Link>
        </div>
      ) : (
        <div className="overflow-x-auto pb-2">
          <div className="flex min-w-[1080px] flex-col gap-4">
            {lanes.map(({ lane, columns }) => (
              <div key={lane || "all"} data-testid={`swimlane-${lane || "all"}`}>
                {lane ? (
                  <div className="pb-1.5 text-[11px] font-semibold tracking-[0.08em] text-(--color-text-muted) uppercase">
                    {lane}
                  </div>
                ) : null}
                <div className="grid grid-cols-6 gap-3">
                  {columns.map((col) => (
                    <section
                      key={col.key}
                      data-wf-column={col.key}
                      data-testid={`col-${col.key}`}
                      className={`flex flex-col gap-2 rounded-[10px] transition-all duration-150 ${
                        dropTarget === col.key ? "bg-(--accent-tint)" : ""
                      }`}
                    >
                      <header
                        className={`flex items-baseline justify-between rounded-[10px] border border-(--color-border) px-2.5 py-1.5 ${
                          col.cards.length === 0 ? "opacity-60" : ""
                        }`}
                      >
                        <span className="text-[11px] font-semibold tracking-[0.06em] uppercase">
                          {COLUMN_LABEL[col.key]}
                        </span>
                        <span className="text-[10px] text-(--color-text-muted)">
                          {col.cards.length}
                        </span>
                      </header>
                      <div className="flex min-h-24 flex-col gap-2">
                        {col.cards.map((c) => (
                          <BoardCard
                            key={c.issue_id}
                            card={c}
                            column={col.key}
                            onMove={(issueId, to) =>
                              moveMutation.mutate({ issueId, column: to })
                            }
                            onReset={(issueId) => resetMutation.mutate(issueId)}
                            onDragTarget={setDropTarget}
                          />
                        ))}
                      </div>
                    </section>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
```

The `LaneBy` type from `board-types.ts` and `BoardLaneBy` from `board-filters.ts` are structurally identical string unions, so `lanesFor(filteredData, laneBy)` type-checks without changes to `board-types.ts`.

- [ ] **Step 4: Run the new spec + existing board spec**

Run: `cd frontend && npx playwright test e2e/board-filters.spec.ts e2e/board.spec.ts`
Expected: PASS. If `board.spec.ts` asserts lane-by behavior, it still passes — the toggle is now URL-driven but `aria-pressed`/lane rendering are unchanged. Fix any board.spec assertion that hardcodes the absence of URL params by widening it (e.g. `toHaveURL(/\/plan\/board/)`).

- [ ] **Step 5: Lint, build, commit**

Run: `cd frontend && npm run lint && npm run build`

```bash
git add frontend/src/app/plan/board/board-client.tsx frontend/e2e/board-filters.spec.ts
git commit -m "feat: board filter chips, URL-backed lane_by, save board views"
```

---

### Task 8: Table save button (toolbar slot)

**Files:**
- Modify: `frontend/src/app/plan/plan-client.tsx` (imports, filters snapshot, Toolbar call)
- Modify: `frontend/src/app/plan/toolbar.tsx` (new `saveSlot` prop)
- Test (new): `frontend/e2e/save-table-view.spec.ts`

**Interfaces:**
- Consumes: `parseTableFilters`/`hasActiveTableFilters` (Task 4), `SaveViewButton` (Task 6).
- Produces: saved table views POST `filters: {state,label,assignee,q,type,component,max_readiness,sort,order}`.

- [ ] **Step 1: Write the failing e2e spec**

Create `frontend/e2e/save-table-view.spec.ts`:

```ts
import { expect, test, type Page, type Route } from "@playwright/test";

async function stubTable(page: Page, posts: unknown[] = []) {
  await page.route(/\/api\/backend\/repositories$/, (route: Route) =>
    route.fulfill({ json: [{ id: 500, full_name: "patelmj/mehova" }] }),
  );
  await page.route(/\/api\/backend\/issues\/facets/, (route: Route) =>
    route.fulfill({ json: { labels: [], assignees: [], components: [] } }),
  );
  await page.route(/\/api\/backend\/issues\?/, (route: Route) =>
    route.fulfill({ json: { items: [], total: 0, limit: 50, offset: 0 } }),
  );
  await page.route(/\/api\/backend\/views$/, (route: Route) => {
    if (route.request().method() === "POST") {
      const body = route.request().postDataJSON();
      posts.push(body);
      return route.fulfill({
        status: 201,
        json: {
          id: 1,
          position: 0,
          created_at: "2026-07-22T00:00:00Z",
          ...(body as object),
        },
      });
    }
    return route.fulfill({ json: [] });
  });
}

test("save is disabled without a repo or without non-default state", async ({
  page,
}) => {
  await stubTable(page);
  await page.goto("/plan");
  await expect(page.getByTestId("save-view")).toBeDisabled();
  await page.goto("/plan?repo_id=500");
  await expect(page.getByTestId("save-view")).toBeDisabled();
  await page.goto("/plan?repo_id=500&type=bug");
  await expect(page.getByTestId("save-view")).toBeEnabled();
});

test("saving posts the full table snapshot including sort", async ({ page }) => {
  const posts: unknown[] = [];
  await stubTable(page, posts);
  await page.goto(
    "/plan?repo_id=500&type=bug&max_readiness=50&sort=readiness&order=asc",
  );
  await page.getByTestId("save-view").click();
  await page.getByTestId("save-view-name").fill("Readiness gaps");
  await page.getByTestId("save-view-submit").click();

  await expect.poll(() => posts.length).toBe(1);
  expect(posts[0]).toEqual({
    name: "Readiness gaps",
    view_kind: "table",
    repository_id: 500,
    filters: {
      state: "open",
      label: null,
      assignee: null,
      q: null,
      type: "bug",
      component: null,
      max_readiness: "50",
      sort: "readiness",
      order: "asc",
    },
  });
});
```

- [ ] **Step 2: Run the spec to verify it fails**

Run: `cd frontend && npx playwright test e2e/save-table-view.spec.ts`
Expected: FAIL (`save-view` testid not found on /plan)

- [ ] **Step 3: Add the saveSlot to Toolbar**

In `frontend/src/app/plan/toolbar.tsx`:

Add to imports: `import type { ReactNode } from "react";`

Change the component signature:

```tsx
export function Toolbar({
  params,
  visible,
  onToggleColumn,
  saveSlot,
}: {
  params: TableParams;
  visible: Set<ColumnKey>;
  onToggleColumn: (key: ColumnKey) => void;
  saveSlot?: ReactNode;
}) {
```

Render the slot right after `<div className="grow" />` (before the Columns `<details>`):

```tsx
      <div className="grow" />

      {saveSlot}

      <details className="relative">
```

- [ ] **Step 4: Wire it in plan-client**

In `frontend/src/app/plan/plan-client.tsx`:

Add imports:

```tsx
import { SaveViewButton } from "../../components/save-view";
import {
  hasActiveTableFilters,
  parseTableFilters,
} from "../../lib/table-filters";
```

After the URL param parsing block (after the `offset` line), add:

```tsx
  const tableViewFilters = parseTableFilters(searchParams);
```

Change the `<Toolbar ... />` call to pass the slot:

```tsx
      <Toolbar
        params={{
          repoId,
          state,
          label,
          assignee,
          q,
          type: typeFilter,
          component,
          maxReadiness,
          setParams,
        }}
        visible={visible}
        onToggleColumn={onToggleColumn}
        saveSlot={
          <SaveViewButton
            viewKind="table"
            repositoryId={repoId ? Number(repoId) : null}
            canSave={!!repoId && hasActiveTableFilters(tableViewFilters)}
            filters={{ ...tableViewFilters }}
          />
        }
      />
```

- [ ] **Step 5: Run the spec + table spec to verify pass**

Run: `cd frontend && npx playwright test e2e/save-table-view.spec.ts e2e/issues-table.spec.ts`
Expected: PASS

- [ ] **Step 6: Lint, build, commit**

Run: `cd frontend && npm run lint && npm run build`

```bash
git add frontend/src/app/plan/plan-client.tsx frontend/src/app/plan/toolbar.tsx frontend/e2e/save-table-view.spec.ts
git commit -m "feat: save table views from the plan toolbar"
```

---

### Task 9: /views page — repo groups, kind badges, drag reorder

**Files:**
- Modify: `frontend/src/app/views/views-client.tsx` (full rewrite below)
- Test: `frontend/e2e/views.spec.ts` (update), Create: `frontend/e2e/views-reorder.spec.ts`

**Interfaces:**
- Consumes: `savedViewHref`/`savedViewKindLabel`/`savedViewSummary`/`reorderViews`/`SavedView` (Task 5).
- Produces: repo section testid `views-repo-<repoId>`; row keeps `view-row-<id>`, `view-open-<id>`, `view-rename-<id>`, `view-delete-<id>`; new drag handle `view-drag-<id>`; rows carry `data-view-row`/`data-repo-id` attributes for drop detection.

- [ ] **Step 1: Update views.spec.ts for grouping + mixed kinds (failing first)**

In `frontend/e2e/views.spec.ts`:

Add `position: number` to the local `View` type. Replace `initialViews` with:

```ts
const initialViews: View[] = [
  {
    id: 1,
    name: "Ready bugs",
    view_kind: "matrix",
    repository_id: 500,
    filters: { types: ["bug"], readiness: "ready" },
    position: 0,
    created_at: "2026-07-21T00:00:00Z",
  },
  {
    id: 2,
    name: "Docs pile",
    view_kind: "matrix",
    repository_id: 500,
    filters: { types: ["docs"], readiness: null },
    position: 1,
    created_at: "2026-07-20T00:00:00Z",
  },
  {
    id: 3,
    name: "By assignee",
    view_kind: "board",
    repository_id: 500,
    filters: { lane_by: "assignee", types: ["bug"], readiness: null },
    position: 2,
    created_at: "2026-07-22T00:00:00Z",
  },
  {
    id: 4,
    name: "Readiness gaps",
    view_kind: "table",
    repository_id: 600,
    filters: { type: "bug", max_readiness: "50", sort: "readiness", order: "asc" },
    position: 0,
    created_at: "2026-07-22T00:00:00Z",
  },
];
```

In `stubViews`, change the repositories stub to return both repos:

```ts
  await page.route(/\/api\/backend\/repositories$/, (route: Route) =>
    route.fulfill({
      json: [
        { id: 500, full_name: "patelmj/mehova" },
        { id: 600, full_name: "patelmj/issuelens" },
      ],
    }),
  );
```

Replace the first test (`lists views with repo, summary, and open link`) with:

```ts
test("groups views by repo with kind badges, summaries, and open links", async ({
  page,
}) => {
  await stubViews(page, { patches: [], deletes: [] });
  await page.goto("/views");

  const mehova = page.getByTestId("views-repo-500");
  await expect(mehova).toContainText("patelmj/mehova");
  const row1 = page.getByTestId("view-row-1");
  await expect(row1).toContainText("Ready bugs");
  await expect(row1).toContainText("Bug · Ready (≥80)");
  await expect(row1).toContainText("Matrix");
  await expect(page.getByTestId("view-open-1")).toHaveAttribute(
    "href",
    "/plan/matrix?repo_id=500&types=bug&readiness=ready",
  );

  const row3 = page.getByTestId("view-row-3");
  await expect(row3).toContainText("Board");
  await expect(row3).toContainText("Laned by assignee · Bug");
  await expect(page.getByTestId("view-open-3")).toHaveAttribute(
    "href",
    "/plan/board?repo_id=500&types=bug&lane_by=assignee",
  );

  const issuelens = page.getByTestId("views-repo-600");
  await expect(issuelens).toContainText("patelmj/issuelens");
  const row4 = page.getByTestId("view-row-4");
  await expect(row4).toContainText("Table");
  await expect(row4).toContainText("Open · bug · readiness <50% · by readiness ↑");
  await expect(page.getByTestId("view-open-4")).toHaveAttribute(
    "href",
    "/plan?repo_id=600&type=bug&max_readiness=50&sort=readiness&order=asc",
  );
});
```

Leave the rename/delete/empty/error tests unchanged (testids are preserved). In the delete test, `view-row-2` remains valid.

- [ ] **Step 2: Write the failing reorder spec**

Create `frontend/e2e/views-reorder.spec.ts`:

```ts
import { expect, test, type Page, type Route } from "@playwright/test";

type View = {
  id: number;
  name: string;
  view_kind: string;
  repository_id: number | null;
  filters: unknown;
  position: number;
  created_at: string;
};

const initialViews: View[] = [
  {
    id: 1,
    name: "Ready bugs",
    view_kind: "matrix",
    repository_id: 500,
    filters: { types: ["bug"], readiness: "ready" },
    position: 0,
    created_at: "2026-07-21T00:00:00Z",
  },
  {
    id: 2,
    name: "Docs pile",
    view_kind: "matrix",
    repository_id: 500,
    filters: { types: ["docs"], readiness: null },
    position: 1,
    created_at: "2026-07-20T00:00:00Z",
  },
];

/** Stateful stub: PUT /views/order mutates the list the GET returns. */
async function stubReorder(page: Page, orderCalls: unknown[], putStatus = 200) {
  let views: View[] = structuredClone(initialViews);
  await page.route(/\/api\/backend\/repositories$/, (route: Route) =>
    route.fulfill({ json: [{ id: 500, full_name: "patelmj/mehova" }] }),
  );
  await page.route(/\/api\/backend\/views$/, (route: Route) =>
    route.fulfill({ json: views }),
  );
  await page.route(/\/api\/backend\/views\/order$/, (route: Route) => {
    const body = route.request().postDataJSON() as {
      repository_id: number;
      ordered_ids: number[];
    };
    orderCalls.push(body);
    if (putStatus !== 200) {
      return route.fulfill({ status: putStatus, json: { detail: "boom" } });
    }
    views = body.ordered_ids
      .map((id, index) => {
        const view = views.find((v) => v.id === id)!;
        return { ...view, position: index };
      })
      .concat(views.filter((v) => v.repository_id !== body.repository_id));
    return route.fulfill({ json: views });
  });
}

async function dragRow(page: Page, fromId: number, toId: number) {
  const handle = page.getByTestId(`view-drag-${fromId}`);
  const target = page.getByTestId(`view-row-${toId}`);
  const hb = (await handle.boundingBox())!;
  const tb = (await target.boundingBox())!;
  await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2);
  await page.mouse.down();
  await page.mouse.move(tb.x + tb.width / 2, tb.y + tb.height / 2, { steps: 8 });
  await page.mouse.up();
}

test("drag reorders within the repo group and persists across reload", async ({
  page,
}) => {
  const orderCalls: unknown[] = [];
  await stubReorder(page, orderCalls);
  await page.goto("/views");
  await expect(page.getByTestId("view-row-1")).toBeVisible();

  await dragRow(page, 1, 2);
  await expect.poll(() => orderCalls.length).toBe(1);
  expect(orderCalls[0]).toEqual({ repository_id: 500, ordered_ids: [2, 1] });

  const rows = page.locator("[data-view-row]");
  await expect(rows.first()).toContainText("Docs pile");

  await page.reload();
  await expect(page.locator("[data-view-row]").first()).toContainText("Docs pile");
});

test("failed reorder rolls back and shows an inline error", async ({ page }) => {
  const orderCalls: unknown[] = [];
  await stubReorder(page, orderCalls, 500);
  await page.goto("/views");
  await expect(page.getByTestId("view-row-1")).toBeVisible();

  await dragRow(page, 1, 2);
  await expect.poll(() => orderCalls.length).toBe(1);
  await expect(page.getByTestId("views-action-error")).toContainText("boom");
  await expect(page.locator("[data-view-row]").first()).toContainText("Ready bugs");
});
```

- [ ] **Step 3: Run both specs to verify they fail**

Run: `cd frontend && npx playwright test e2e/views.spec.ts e2e/views-reorder.spec.ts`
Expected: FAIL (no groups, no drag handles)

- [ ] **Step 4: Rewrite views-client.tsx**

Replace the full contents of `frontend/src/app/views/views-client.tsx` with:

```tsx
"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useMemo, useRef, useState } from "react";
import { getJson, sendJson } from "../../lib/api";
import {
  fetchViews,
  reorderViews,
  savedViewHref,
  savedViewKindLabel,
  savedViewSummary,
  VIEWS_KEY,
  type SavedView,
} from "../../lib/views";

const card =
  "rounded-[14px] border border-(--color-border) bg-(--color-surface) shadow-(--shadow-card)";

const DRAG_THRESHOLD_PX = 6;

type Repo = { id: number; full_name: string };

function rowUnderPointer(x: number, y: number, repoId: number): number | null {
  const hit = document
    .elementsFromPoint(x, y)
    .find(
      (el): el is HTMLElement =>
        el instanceof HTMLElement &&
        el.dataset.viewRow != null &&
        el.dataset.repoId === String(repoId),
    );
  return hit ? Number(hit.dataset.viewRow) : null;
}

export function ViewsClient() {
  const queryClient = useQueryClient();
  const { data: views, error, isPending } = useQuery({
    queryKey: VIEWS_KEY,
    queryFn: fetchViews,
  });
  const { data: repos } = useQuery({
    queryKey: ["repositories"],
    queryFn: () => getJson<Repo[]>("/api/backend/repositories"),
  });

  const [renamingId, setRenamingId] = useState<number | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [confirmDeleteId, setConfirmDeleteId] = useState<number | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const dragRef = useRef<{
    viewId: number;
    repoId: number;
    startX: number;
    startY: number;
    active: boolean;
  } | null>(null);
  const [draggingId, setDraggingId] = useState<number | null>(null);
  const [dragTargetId, setDragTargetId] = useState<number | null>(null);

  const renameMutation = useMutation({
    mutationFn: ({ id, name }: { id: number; name: string }) =>
      sendJson<SavedView>(`/api/backend/views/${id}`, "PATCH", { name }),
    onSuccess: () => {
      setRenamingId(null);
      setActionError(null);
    },
    onError: (err) => setActionError(err.message),
    onSettled: () => queryClient.invalidateQueries({ queryKey: VIEWS_KEY }),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: number) =>
      sendJson<undefined>(`/api/backend/views/${id}`, "DELETE"),
    onSuccess: () => {
      setConfirmDeleteId(null);
      setActionError(null);
    },
    onError: (err) => setActionError(err.message),
    onSettled: () => queryClient.invalidateQueries({ queryKey: VIEWS_KEY }),
  });

  const reorderMutation = useMutation({
    mutationFn: ({
      repositoryId,
      orderedIds,
    }: {
      repositoryId: number;
      orderedIds: number[];
    }) => reorderViews(repositoryId, orderedIds),
    onMutate: async ({ repositoryId, orderedIds }) => {
      await queryClient.cancelQueries({ queryKey: VIEWS_KEY });
      const previous = queryClient.getQueryData<SavedView[]>(VIEWS_KEY);
      queryClient.setQueryData<SavedView[]>(VIEWS_KEY, (old) => {
        if (!old) return old;
        const inRepo = new Map(
          old.filter((v) => v.repository_id === repositoryId).map((v) => [v.id, v]),
        );
        const reordered = orderedIds
          .map((id) => inRepo.get(id))
          .filter((v): v is SavedView => v != null);
        return [...old.filter((v) => v.repository_id !== repositoryId), ...reordered];
      });
      setActionError(null);
      return { previous };
    },
    onError: (err, _vars, context) => {
      if (context?.previous) queryClient.setQueryData(VIEWS_KEY, context.previous);
      setActionError(err.message);
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: VIEWS_KEY }),
  });

  const repoName = (id: number | null) =>
    repos?.find((repo) => repo.id === id)?.full_name ?? "—";

  // API returns (repository_id, position, id) order, so within-group order
  // is already the user's ordering.
  const groups = useMemo(() => {
    const byRepo = new Map<number | null, SavedView[]>();
    for (const view of views ?? []) {
      byRepo.set(view.repository_id, [
        ...(byRepo.get(view.repository_id) ?? []),
        view,
      ]);
    }
    return [...byRepo.entries()]
      .map(([repoId, groupViews]) => ({
        repoId,
        name: repoName(repoId),
        views: groupViews,
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [views, repos]);

  const commitDrag = (clientX: number, clientY: number) => {
    const state = dragRef.current;
    dragRef.current = null;
    setDraggingId(null);
    setDragTargetId(null);
    if (!state?.active) return;
    const targetId = rowUnderPointer(clientX, clientY, state.repoId);
    if (targetId == null || targetId === state.viewId) return;
    const group = groups.find((g) => g.repoId === state.repoId);
    if (!group) return;
    const ids = group.views.map((v) => v.id);
    const from = ids.indexOf(state.viewId);
    ids.splice(from, 1);
    const targetIndex = ids.indexOf(targetId);
    ids.splice(from <= targetIndex ? targetIndex + 1 : targetIndex, 0, state.viewId);
    reorderMutation.mutate({ repositoryId: state.repoId, orderedIds: ids });
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-baseline gap-3">
        <h1 className="text-lg font-semibold tracking-[-0.01em]">Saved Views</h1>
        <span className="text-(--color-text-muted)">
          Your custom filters, one click away
        </span>
      </div>

      {actionError ? (
        <div className="text-(--color-danger)" data-testid="views-action-error">
          {actionError}
        </div>
      ) : null}

      {isPending ? (
        <div className={`${card} px-6 py-16 text-center text-(--color-text-muted)`}>
          Loading views…
        </div>
      ) : error ? (
        <div className={`${card} px-6 py-16 text-center`} data-testid="views-error">
          <div className="text-sm font-medium">Backend unavailable</div>
          <div className="pt-1.5 text-(--color-text-muted)">{error.message}</div>
        </div>
      ) : views && views.length === 0 ? (
        <div
          className={`${card} flex flex-col items-center gap-1.5 px-6 py-16 text-center`}
          data-testid="views-empty"
        >
          <div className="text-sm font-medium">No saved views yet</div>
          <div className="max-w-md text-(--color-text-muted)">
            Save any filtered table, matrix, or board as a named view and it will
            be listed here.
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-4" data-testid="views-list">
          {groups.map((group) => (
            <section
              key={group.repoId ?? "none"}
              data-testid={`views-repo-${group.repoId ?? "none"}`}
            >
              <h2 className="pb-1.5 text-[11px] font-semibold tracking-[0.08em] text-(--color-text-muted) uppercase">
                {group.name}
              </h2>
              <ul className={`${card} divide-y divide-(--color-border)`}>
                {group.views.map((view) => {
                  const href = savedViewHref(view);
                  return (
                    <li
                      key={view.id}
                      data-view-row={view.id}
                      data-repo-id={view.repository_id ?? ""}
                      className={`flex items-center gap-3 px-4 py-3 transition-all duration-150 ${
                        draggingId === view.id ? "opacity-60" : ""
                      } ${dragTargetId === view.id ? "bg-(--accent-tint)" : ""}`}
                      data-testid={`view-row-${view.id}`}
                    >
                      <button
                        type="button"
                        data-testid={`view-drag-${view.id}`}
                        aria-label={`Reorder ${view.name}`}
                        className="cursor-grab touch-none px-1 text-(--color-text-muted) select-none"
                        onPointerDown={(e) => {
                          if (e.button !== 0 || view.repository_id == null) return;
                          dragRef.current = {
                            viewId: view.id,
                            repoId: view.repository_id,
                            startX: e.clientX,
                            startY: e.clientY,
                            active: false,
                          };
                          e.currentTarget.setPointerCapture(e.pointerId);
                        }}
                        onPointerMove={(e) => {
                          const state = dragRef.current;
                          if (!state) return;
                          if (!state.active) {
                            const moved = Math.hypot(
                              e.clientX - state.startX,
                              e.clientY - state.startY,
                            );
                            if (moved < DRAG_THRESHOLD_PX) return;
                            state.active = true;
                            setDraggingId(state.viewId);
                          }
                          setDragTargetId(
                            rowUnderPointer(e.clientX, e.clientY, state.repoId),
                          );
                        }}
                        onPointerUp={(e) => commitDrag(e.clientX, e.clientY)}
                        onPointerCancel={() => {
                          dragRef.current = null;
                          setDraggingId(null);
                          setDragTargetId(null);
                        }}
                      >
                        ⠿
                      </button>
                      <div className="min-w-0 grow">
                        {renamingId === view.id ? (
                          <form
                            className="flex items-center gap-2"
                            onSubmit={(e) => {
                              e.preventDefault();
                              if (renameValue.trim() && !renameMutation.isPending) {
                                renameMutation.mutate({
                                  id: view.id,
                                  name: renameValue.trim(),
                                });
                              }
                            }}
                          >
                            <input
                              autoFocus
                              data-testid="view-rename-input"
                              value={renameValue}
                              onChange={(e) => setRenameValue(e.target.value)}
                              aria-label="View name"
                              className="rounded-lg border border-(--color-border) bg-(--color-bg) px-2.5 py-1"
                            />
                            <button
                              type="submit"
                              data-testid="view-rename-save"
                              disabled={
                                !renameValue.trim() || renameMutation.isPending
                              }
                              className="rounded-lg bg-(--accent-tint) px-2.5 py-1 font-medium text-(--color-primary) transition-all duration-150 disabled:opacity-60"
                            >
                              Save
                            </button>
                            <button
                              type="button"
                              data-testid="view-rename-cancel"
                              className="text-(--color-text-muted) transition-all duration-150 hover:text-(--color-text)"
                              onClick={() => setRenamingId(null)}
                            >
                              Cancel
                            </button>
                          </form>
                        ) : (
                          <div className="flex items-center gap-2">
                            <span className="truncate font-medium">{view.name}</span>
                            <span className="rounded-full border border-(--color-border) px-1.5 text-[10px] text-(--color-text-muted) uppercase">
                              {savedViewKindLabel(view)}
                            </span>
                          </div>
                        )}
                        <div className="truncate pt-0.5 text-(--color-text-muted)">
                          {savedViewSummary(view)}
                        </div>
                      </div>
                      {href != null ? (
                        <Link
                          href={href}
                          data-testid={`view-open-${view.id}`}
                          className="rounded-lg border border-(--color-border) px-2.5 py-1 text-(--color-primary) transition-all duration-150 hover:bg-(--accent-tint)"
                        >
                          Open
                        </Link>
                      ) : null}
                      <button
                        type="button"
                        data-testid={`view-rename-${view.id}`}
                        className="rounded-lg border border-(--color-border) px-2.5 py-1 text-(--color-text-muted) transition-all duration-150 hover:text-(--color-text)"
                        onClick={() => {
                          setRenamingId(view.id);
                          setRenameValue(view.name);
                          setConfirmDeleteId(null);
                          setActionError(null);
                        }}
                      >
                        Rename
                      </button>
                      <button
                        type="button"
                        data-testid={`view-delete-${view.id}`}
                        disabled={
                          deleteMutation.isPending && confirmDeleteId === view.id
                        }
                        className={`rounded-lg border px-2.5 py-1 transition-all duration-150 disabled:opacity-60 ${
                          confirmDeleteId === view.id
                            ? "border-(--color-danger) text-(--color-danger)"
                            : "border-(--color-border) text-(--color-text-muted) hover:text-(--color-text)"
                        }`}
                        onClick={() => {
                          if (confirmDeleteId === view.id) {
                            if (!deleteMutation.isPending) {
                              deleteMutation.mutate(view.id);
                            }
                          } else {
                            setConfirmDeleteId(view.id);
                            setRenamingId(null);
                            setActionError(null);
                          }
                        }}
                      >
                        {confirmDeleteId === view.id ? "Confirm delete" : "Delete"}
                      </button>
                    </li>
                  );
                })}
              </ul>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}
```

Note the summary line no longer prefixes the repo name — the group header carries it now.

- [ ] **Step 5: Run the specs to verify they pass**

Run: `cd frontend && npx playwright test e2e/views.spec.ts e2e/views-reorder.spec.ts`
Expected: PASS (all, including the untouched rename/delete/error tests)

- [ ] **Step 6: Lint, build, commit**

Run: `cd frontend && npm run lint && npm run build`

```bash
git add frontend/src/app/views/views-client.tsx frontend/e2e/views.spec.ts frontend/e2e/views-reorder.spec.ts
git commit -m "feat: repo-grouped /views with kind badges and drag reordering"
```

---

### Task 10: Sidenav — all kinds, repo groups, kind-aware active state

**Files:**
- Modify: `frontend/src/components/sidenav.tsx` (full rewrite below)
- Test: `frontend/e2e/saved-views-nav.spec.ts` (update)

**Interfaces:**
- Consumes: `savedViewHref`/`savedViewKindLabel` (Task 5), all three codecs' `parse*`/`*ToSearch` (Task 4).
- Produces: sidenav lists every known-kind view grouped by repo; testid `saved-view-link-<id>` preserved; count pill unchanged (`views-count`, counts all views — now correct).

- [ ] **Step 1: Update the nav spec (failing first)**

Rewrite `frontend/e2e/saved-views-nav.spec.ts` — same file structure, these changes:

- Add `position` to both stub views, and append a third view:

```ts
  {
    id: 3,
    name: "Readiness gaps",
    view_kind: "table",
    repository_id: 500,
    filters: { type: "bug", max_readiness: "50", sort: "readiness", order: "asc" },
    position: 2,
    created_at: "2026-07-22T00:00:00Z",
  },
```

(and `position: 0` / `position: 1` on views 1 and 2).

- First test becomes:

```ts
test("sidebar lists saved views grouped by repo with a live count pill", async ({
  page,
}) => {
  await stubAll(page);
  await page.goto("/plan/matrix");
  const nav = page.getByRole("navigation", { name: "Primary" });
  await expect(nav.getByTestId("saved-view-link-1")).toContainText("Ready bugs");
  await expect(nav.getByTestId("saved-view-link-2")).toContainText("Docs pile");
  await expect(nav.getByTestId("saved-view-link-3")).toContainText("Readiness gaps");
  await expect(nav).toContainText("mehova");
  await expect(nav.getByTestId("views-count")).toHaveText("3");
});
```

- In the second test, change the two `toHaveText`-free assertions only as needed: the URL/filters assertions stay; the class assertion stays.
- Third test (`views fetch failure`) unchanged.
- Fourth test (canonical matrix URL) unchanged.
- Append a new canonical test for table views:

```ts
test("table view link is active on a hand-ordered table URL", async ({ page }) => {
  await stubAll(page);
  await page.route(/\/api\/backend\/issues\/facets/, (route: Route) =>
    route.fulfill({ json: { labels: [], assignees: [], components: [] } }),
  );
  await page.route(/\/api\/backend\/issues\?/, (route: Route) =>
    route.fulfill({ json: { items: [], total: 0, limit: 50, offset: 0 } }),
  );
  // same params as view 3's canonical href, deliberately reordered
  await page.goto("/plan?sort=readiness&order=asc&type=bug&repo_id=500&max_readiness=50");
  await expect(page.getByTestId("saved-view-link-3")).toHaveClass(
    /text-\(--color-primary\)/,
  );
});
```

- [ ] **Step 2: Run the spec to verify it fails**

Run: `cd frontend && npx playwright test e2e/saved-views-nav.spec.ts`
Expected: FAIL (link 3 missing — sidenav filters to matrix only; no repo label)

- [ ] **Step 3: Rewrite sidenav.tsx**

Replace the full contents of `frontend/src/components/sidenav.tsx` with:

```tsx
"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { getJson } from "../lib/api";
import { boardFiltersToSearch, parseBoardFilters } from "../lib/board-filters";
import { filtersToSearch, parseFilters } from "../lib/matrix-filters";
import { parseTableFilters, tableFiltersToSearch } from "../lib/table-filters";
import {
  fetchViews,
  savedViewHref,
  savedViewKindLabel,
  VIEWS_KEY,
  type SavedView,
} from "../lib/views";

export const NAV_ITEMS = [
  {
    group: "Workspace",
    items: [
      { label: "Overview", href: "/" },
      { label: "Triage", href: "/triage" },
      {
        label: "Plan",
        href: "/plan",
        children: [
          { label: "Table", href: "/plan" },
          { label: "Matrix", href: "/plan/matrix" },
          { label: "Board", href: "/plan/board" },
        ],
      },
      { label: "Analyze", href: "/analyze" },
    ],
  },
  {
    group: "Library",
    items: [
      { label: "Saved Views", href: "/views" },
      { label: "Repositories", href: "/repositories" },
    ],
  },
];

type Repo = { id: number; full_name: string };

const childLink = (active: boolean) =>
  `flex items-center rounded-lg py-1.5 pl-7 transition-all duration-150 ${
    active
      ? "bg-(--accent-tint) font-medium text-(--color-primary)"
      : "text-(--color-text-muted) hover:bg-(--accent-tint) hover:text-(--color-text)"
  }`;

function SavedViewLink({ view, currentUrl }: { view: SavedView; currentUrl: string }) {
  const viewHref = savedViewHref(view);
  const kindInitial = (
    <span className="w-3.5 shrink-0 text-[10px] font-semibold text-(--color-text-muted)">
      {savedViewKindLabel(view)[0]?.toUpperCase() ?? "?"}
    </span>
  );
  if (viewHref == null) {
    return (
      <span className={`${childLink(false)} cursor-default gap-1.5`}>
        {kindInitial}
        <span className="truncate">{view.name}</span>
      </span>
    );
  }
  return (
    <Link
      href={viewHref}
      data-testid={`saved-view-link-${view.id}`}
      className={`${childLink(currentUrl === viewHref)} gap-1.5`}
    >
      {kindInitial}
      <span className="truncate">{view.name}</span>
    </Link>
  );
}

export function Sidenav() {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const repoParam = searchParams.get("repo_id");
  const repoId = repoParam ? Number(repoParam) : null;
  // Canonical search for the *current* surface, so hand-ordered URLs still
  // highlight the matching saved view.
  const canonicalSearch =
    pathname === "/plan/matrix"
      ? filtersToSearch(repoId, parseFilters(searchParams))
      : pathname === "/plan"
        ? tableFiltersToSearch(repoId, parseTableFilters(searchParams))
        : pathname === "/plan/board"
          ? boardFiltersToSearch(repoId, parseBoardFilters(searchParams))
          : "";
  const currentUrl = canonicalSearch ? `${pathname}?${canonicalSearch}` : pathname;

  const { data: views } = useQuery({
    queryKey: VIEWS_KEY,
    queryFn: fetchViews,
    retry: false,
    staleTime: 30_000,
  });
  const { data: repos } = useQuery({
    queryKey: ["repositories"],
    queryFn: () => getJson<Repo[]>("/api/backend/repositories"),
    retry: false,
    staleTime: 30_000,
  });

  const allViews = views ?? [];
  // Repo groups in API repo order; flat fallback while repos are unavailable.
  const groups: { label: string | null; views: SavedView[] }[] = repos
    ? repos
        .map((repo) => ({
          label: repo.full_name.split("/")[1] ?? repo.full_name,
          views: allViews.filter((view) => view.repository_id === repo.id),
        }))
        .filter((group) => group.views.length > 0)
    : allViews.length
      ? [{ label: null, views: allViews }]
      : [];

  return (
    <nav aria-label="Primary" className="flex flex-col gap-5 py-1">
      {NAV_ITEMS.map(({ group, items }) => (
        <div key={group}>
          <div className="px-3 pb-1.5 text-[10px] font-semibold tracking-[0.08em] text-(--color-text-muted) uppercase">
            {group}
          </div>
          <ul className="flex flex-col gap-0.5">
            {items.map(({ label, href, children }) => {
              const active = pathname === href;
              const sectionActive =
                !active && !!children && pathname.startsWith(`${href}/`);
              return (
                <li key={href}>
                  <Link
                    href={href}
                    aria-current={active ? "page" : undefined}
                    className={`flex items-center justify-between rounded-lg px-3 py-1.5 transition-all duration-150 ${
                      active
                        ? "bg-(--accent-tint) font-medium text-(--color-primary)"
                        : sectionActive
                          ? "bg-(--accent-tint) text-(--color-text-muted) hover:text-(--color-text)"
                          : "text-(--color-text-muted) hover:bg-(--accent-tint) hover:text-(--color-text)"
                    }`}
                  >
                    <span>{label}</span>
                    <span
                      className="rounded-full border border-(--color-border) px-1.5 text-[10px] text-(--color-text-muted)"
                      data-testid={href === "/views" ? "views-count" : undefined}
                    >
                      {href === "/views" && views ? views.length : "–"}
                    </span>
                  </Link>
                  {children ? (
                    <ul className="mt-0.5 flex flex-col gap-0.5">
                      {children.map((child) => (
                        <li key={child.href}>
                          <Link
                            href={child.href}
                            aria-current={pathname === child.href ? "page" : undefined}
                            className={childLink(pathname === child.href)}
                          >
                            {child.label}
                          </Link>
                        </li>
                      ))}
                    </ul>
                  ) : null}
                  {href === "/views" && groups.length > 0 ? (
                    <div className="mt-0.5 flex flex-col gap-0.5">
                      {groups.map((viewGroup) => (
                        <div key={viewGroup.label ?? "all"}>
                          {viewGroup.label ? (
                            <div className="pt-1 pb-0.5 pl-7 text-[10px] font-medium text-(--color-text-muted)">
                              {viewGroup.label}
                            </div>
                          ) : null}
                          <ul className="flex flex-col gap-0.5">
                            {viewGroup.views.map((view) => (
                              <li key={view.id}>
                                <SavedViewLink view={view} currentUrl={currentUrl} />
                              </li>
                            ))}
                          </ul>
                        </div>
                      ))}
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </nav>
  );
}
```

- [ ] **Step 4: Run nav + shell specs to verify pass**

Run: `cd frontend && npx playwright test e2e/saved-views-nav.spec.ts e2e/shell.spec.ts e2e/save-view.spec.ts`
Expected: PASS. (`save-view.spec` asserts `saved-view-link-1` has text "Ready bugs" after saving — `toHaveText` there must become `toContainText` since the link now includes the kind initial; make that one-word change in `e2e/save-view.spec.ts` if it fails.)

- [ ] **Step 5: Lint, build, commit**

Run: `cd frontend && npm run lint && npm run build`

```bash
git add frontend/src/components/sidenav.tsx frontend/e2e/saved-views-nav.spec.ts frontend/e2e/save-view.spec.ts
git commit -m "feat: sidenav lists all view kinds grouped by repo, kind-aware active state"
```

---

### Task 11: Full-suite verification

**Files:** none (verification only)

- [ ] **Step 1: Backend full suite + lint**

Run: `cd backend && python -m pytest && python -m ruff check .`
Expected: all tests pass, ruff clean.

- [ ] **Step 2: Frontend lint + build**

Run: `cd frontend && npm run lint && npm run build`
Expected: clean.

- [ ] **Step 3: Full e2e suite at default parallelism**

First: `docker ps` — if a stale `issuelens-frontend-1` container is bound to :3005, stop it (`docker stop issuelens-frontend-1`).

Run: `cd frontend && npx playwright test`
Expected: all specs pass, including the three new ones (`board-filters`, `save-table-view`, `views-reorder`).

- [ ] **Step 4: Commit any straggler fixes**

If steps 1–3 required fixes, commit them with a message describing the actual fix (no blanket "fix tests" commit without detail).

---

## Deferred to post-implementation (main session, not subagents)

- Live dogfood on the real synced repo: `docker compose up` (migrate one-shot applies 0011, restart worker+backend), then save/open/reorder all three kinds against real data.
- User review + PR decision per CLAUDE.md workflow.
