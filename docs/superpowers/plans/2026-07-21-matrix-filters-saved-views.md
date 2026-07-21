# Matrix Filter Chips + Saved Views Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Filter chips (type + readiness bucket) on `/plan/matrix` that filter chart, queue, and hover together via URL params, plus backend-persisted saved views surfaced in the sidebar and on a real `/views` page. Implements issue #33 per `docs/superpowers/specs/2026-07-21-matrix-filters-saved-views-design.md`.

**Architecture:** Filters live in URL search params (`?types=bug,debt&readiness=ready`); filtering is pure client-side over the already-fetched matrix payload. A saved view is a named snapshot of those params in a new generic `saved_views` table (`view_kind` + JSONB `filters`, only `"matrix"` implemented), exposed by a 4-endpoint CRUD router. The sidebar and `/views` page read one React Query cache key `["views"]`.

**Tech Stack:** FastAPI + SQLAlchemy async + Alembic (backend), Next.js 16.2.10 + React Query 5 + Tailwind v4 (frontend), pytest + Playwright CLI.

**Branch:** `feat/matrix-filters-views` (already exists, spec committed on it).

## Global Constraints

- Tailwind v4 CSS-variable syntax is **parens**: `bg-(--color-X)`, `text-(--color-X)` — NEVER `bg-[--color-X]` brackets.
- All colors via theme tokens (`--color-*`, `--accent-tint`, `--shadow-card`); no hardcoded colors; dual theme via `data-mode` works automatically if tokens are used.
- Controls: 8px radius (`rounded-lg`), cards: 14px (`rounded-[14px]`), transitions `transition-all duration-150`.
- Inactive/disabled UI elements stay **visible but muted** — never hidden (exceptions explicitly approved in the spec: "Clear filters" renders only when a filter is active).
- **Frontend implementers MUST read the relevant guide in `frontend/node_modules/next/dist/docs/` before writing code** — this Next.js version has breaking changes (`frontend/AGENTS.md`).
- Any client component calling `useSearchParams()` must be wrapped in `<Suspense>` by its parent, or `next build` fails prerendering (the 17c3197 `/triage` lesson).
- All UI testing via **Playwright CLI** (`cd frontend && npx playwright test ...`), never manual browser testing.
- Backend tests need the dev Postgres up: `docker compose up -d db` from repo root. Tests run against `issuelens_test` (auto-created/migrated by conftest), never dev data.
- Before frontend e2e: stop any stale `issuelens-frontend-1` container occupying :3005 (`docker stop issuelens-frontend-1`), or Playwright reuses the stale server.
- Commit messages: imperative, no AI attribution, no Co-Authored-By lines.
- No new dependencies.
- Handle errors explicitly — surfaced inline/toast, never swallowed.

---

### Task 1: Backend — `SavedView` model + Alembic migration 0009 [tier: sonnet]

**Files:**
- Modify: `backend/app/models.py` (append model at end, before `SyncJob` is fine too — append after `IssueWorkflow`)
- Create: `backend/alembic/versions/0009_saved_views.py`
- Modify: `backend/tests/conftest.py:68-73` (add `saved_views` to TRUNCATE list)
- Test: `backend/tests/test_models_views.py`

**Interfaces:**
- Produces: `app.models.SavedView` — columns `id: int (BigInteger PK autoincrement)`, `name: str`, `view_kind: str`, `repository_id: int | None (FK repositories.id ondelete CASCADE)`, `filters: dict (JSONB)`, `created_at`, `updated_at`. Unique constraint `uq_saved_views_kind_name` on `(view_kind, name)`. Task 2's router imports this.

- [ ] **Step 1: Write the failing test**

Create `backend/tests/test_models_views.py`:

```python
import pytest
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError

from app.db import get_sessionmaker
from app.models import Installation, Repository, SavedView


async def seed_repo(session) -> None:
    session.add(Installation(id=42, account_login="patelmj"))
    await session.flush()
    session.add(
        Repository(id=500, installation_id=42, full_name="patelmj/mehova",
                   owner="patelmj", name="mehova")
    )
    await session.flush()


async def test_saved_view_roundtrip_and_defaults(clean_db):
    async with get_sessionmaker()() as session:
        await seed_repo(session)
        view = SavedView(
            name="Ready bugs", view_kind="matrix", repository_id=500,
            filters={"types": ["bug"], "readiness": "ready"},
        )
        session.add(view)
        await session.commit()
        await session.refresh(view)
        assert view.id is not None
        assert view.created_at is not None
        assert view.updated_at is not None
        assert view.filters == {"types": ["bug"], "readiness": "ready"}


async def test_saved_view_unique_kind_name(clean_db):
    async with get_sessionmaker()() as session:
        await seed_repo(session)
        session.add(SavedView(name="Dup", view_kind="matrix",
                              repository_id=500, filters={}))
        await session.commit()
        session.add(SavedView(name="Dup", view_kind="matrix",
                              repository_id=500, filters={}))
        with pytest.raises(IntegrityError):
            await session.commit()


async def test_saved_view_cascades_with_repository(clean_db):
    async with get_sessionmaker()() as session:
        await seed_repo(session)
        session.add(SavedView(name="Doomed", view_kind="matrix",
                              repository_id=500, filters={}))
        await session.commit()
    async with get_sessionmaker()() as session:
        repo = (
            await session.execute(select(Repository).where(Repository.id == 500))
        ).scalar_one()
        await session.delete(repo)
        await session.commit()
        remaining = (await session.execute(select(SavedView))).scalars().all()
        assert remaining == []
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && python -m pytest tests/test_models_views.py -v`
Expected: FAIL — `ImportError: cannot import name 'SavedView' from 'app.models'`

- [ ] **Step 3: Add the model**

Append to `backend/app/models.py` after the `IssueWorkflow` class (uses only already-imported names):

```python
class SavedView(Base):
    __tablename__ = "saved_views"
    __table_args__ = (
        UniqueConstraint("view_kind", "name", name="uq_saved_views_kind_name"),
    )

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    name: Mapped[str] = mapped_column(Text)
    view_kind: Mapped[str] = mapped_column(Text)
    repository_id: Mapped[int | None] = mapped_column(
        BigInteger, ForeignKey("repositories.id", ondelete="CASCADE"), nullable=True
    )
    filters: Mapped[dict] = mapped_column(JSONB, default=dict)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )
```

- [ ] **Step 4: Add the migration**

Create `backend/alembic/versions/0009_saved_views.py`:

```python
"""saved views"""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import JSONB

revision = "0009"
down_revision = "0008"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "saved_views",
        sa.Column("id", sa.BigInteger(), primary_key=True, autoincrement=True),
        sa.Column("name", sa.Text(), nullable=False),
        sa.Column("view_kind", sa.Text(), nullable=False),
        sa.Column(
            "repository_id",
            sa.BigInteger(),
            sa.ForeignKey("repositories.id", ondelete="CASCADE"),
            nullable=True,
        ),
        sa.Column(
            "filters",
            JSONB(),
            nullable=False,
            server_default=sa.text("'{}'::jsonb"),
        ),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.UniqueConstraint("view_kind", "name", name="uq_saved_views_kind_name"),
    )


def downgrade() -> None:
    op.drop_table("saved_views")
```

- [ ] **Step 5: Add `saved_views` to the conftest TRUNCATE list**

In `backend/tests/conftest.py`, the `clean_db` fixture's TRUNCATE statement currently ends with `"sync_jobs RESTART IDENTITY CASCADE"`. Change the SQL string to:

```python
        await conn.execute(
            text(
                "TRUNCATE installations, repositories, issues, issue_classifications, "
                "issue_readiness, issue_priority, issue_priority_pins, issue_workflow, "
                "saved_views, sync_jobs RESTART IDENTITY CASCADE"
            )
        )
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `cd backend && python -m pytest tests/test_models_views.py -v`
Expected: 3 passed (conftest applies `alembic upgrade head`, which picks up 0009).

- [ ] **Step 7: Lint**

Run: `cd backend && python -m ruff check .`
Expected: no errors.

- [ ] **Step 8: Commit**

```bash
git add backend/app/models.py backend/alembic/versions/0009_saved_views.py backend/tests/conftest.py backend/tests/test_models_views.py
git commit -m "feat: saved_views table + SavedView model (migration 0009)"
```

---

### Task 2: Backend — views CRUD router [tier: sonnet]

**Files:**
- Create: `backend/app/routers/views.py`
- Modify: `backend/app/main.py` (import + include router)
- Test: `backend/tests/test_api_views.py`

**Interfaces:**
- Consumes: `app.models.SavedView` from Task 1.
- Produces HTTP API (no `/api` prefix — the Next.js rewrite adds `/api/backend`):
  - `GET /views` → `list[SavedViewOut]` newest first, where `SavedViewOut = {id: int, name: str, view_kind: str, repository_id: int | None, filters: dict, created_at: datetime}`
  - `POST /views` body `{name, view_kind, repository_id, filters}` → 201 `SavedViewOut`; 422 empty name / unknown kind / matrix without repo; 404 unknown repo; 409 duplicate `(view_kind, name)`
  - `PATCH /views/{view_id}` body `{name}` → `SavedViewOut`; 422/404/409
  - `DELETE /views/{view_id}` → 204 (idempotent)

- [ ] **Step 1: Write the failing tests**

Create `backend/tests/test_api_views.py`:

```python
import httpx
import pytest

from app.db import get_sessionmaker
from app.main import app
from app.models import Installation, Repository


@pytest.fixture
async def client():
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as c:
        yield c


async def seed_repo() -> None:
    async with get_sessionmaker()() as session:
        session.add(Installation(id=42, account_login="patelmj"))
        await session.flush()
        session.add(
            Repository(id=500, installation_id=42, full_name="patelmj/mehova",
                       owner="patelmj", name="mehova")
        )
        await session.commit()


MATRIX_VIEW = {
    "name": "Ready bugs",
    "view_kind": "matrix",
    "repository_id": 500,
    "filters": {"types": ["bug"], "readiness": "ready"},
}


async def test_create_and_list_newest_first(client, clean_db):
    await seed_repo()
    resp = await client.post("/views", json=MATRIX_VIEW)
    assert resp.status_code == 201
    created = resp.json()
    assert created["name"] == "Ready bugs"
    assert created["view_kind"] == "matrix"
    assert created["repository_id"] == 500
    assert created["filters"] == {"types": ["bug"], "readiness": "ready"}
    assert created["id"] is not None
    assert created["created_at"] is not None

    resp2 = await client.post(
        "/views",
        json={**MATRIX_VIEW, "name": "Debt only",
              "filters": {"types": ["debt"], "readiness": None}},
    )
    assert resp2.status_code == 201

    listed = (await client.get("/views")).json()
    assert [v["name"] for v in listed] == ["Debt only", "Ready bugs"]


async def test_create_validation(client, clean_db):
    await seed_repo()
    # empty / whitespace name
    resp = await client.post("/views", json={**MATRIX_VIEW, "name": "   "})
    assert resp.status_code == 422
    # unknown view kind
    resp = await client.post("/views", json={**MATRIX_VIEW, "view_kind": "kanban"})
    assert resp.status_code == 422
    # matrix view without a repository
    resp = await client.post("/views", json={**MATRIX_VIEW, "repository_id": None})
    assert resp.status_code == 422
    # unknown repository
    resp = await client.post("/views", json={**MATRIX_VIEW, "repository_id": 999})
    assert resp.status_code == 404


async def test_create_duplicate_name_conflicts(client, clean_db):
    await seed_repo()
    assert (await client.post("/views", json=MATRIX_VIEW)).status_code == 201
    resp = await client.post("/views", json=MATRIX_VIEW)
    assert resp.status_code == 409
    assert "already exists" in resp.json()["detail"]


async def test_create_trims_name(client, clean_db):
    await seed_repo()
    resp = await client.post("/views", json={**MATRIX_VIEW, "name": "  Padded  "})
    assert resp.status_code == 201
    assert resp.json()["name"] == "Padded"


async def test_rename(client, clean_db):
    await seed_repo()
    created = (await client.post("/views", json=MATRIX_VIEW)).json()
    other = (
        await client.post("/views", json={**MATRIX_VIEW, "name": "Other"})
    ).json()

    resp = await client.patch(f"/views/{created['id']}", json={"name": "Renamed"})
    assert resp.status_code == 200
    assert resp.json()["name"] == "Renamed"

    # rename onto an existing (view_kind, name) → 409
    resp = await client.patch(f"/views/{other['id']}", json={"name": "Renamed"})
    assert resp.status_code == 409
    # empty name → 422
    resp = await client.patch(f"/views/{created['id']}", json={"name": " "})
    assert resp.status_code == 422
    # unknown id → 404
    resp = await client.patch("/views/99999", json={"name": "X"})
    assert resp.status_code == 404


async def test_delete_idempotent(client, clean_db):
    await seed_repo()
    created = (await client.post("/views", json=MATRIX_VIEW)).json()
    assert (await client.delete(f"/views/{created['id']}")).status_code == 204
    assert (await client.get("/views")).json() == []
    # deleting again is still 204
    assert (await client.delete(f"/views/{created['id']}")).status_code == 204
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend && python -m pytest tests/test_api_views.py -v`
Expected: FAIL — all tests get 404 (`/views` route does not exist).

- [ ] **Step 3: Write the router**

Create `backend/app/routers/views.py`:

```python
from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException, Response
from pydantic import BaseModel, Field
from sqlalchemy import delete, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.db import get_session
from app.models import Repository, SavedView

router = APIRouter(tags=["views"])

VIEW_KINDS = {"matrix"}


class SavedViewOut(BaseModel):
    id: int
    name: str
    view_kind: str
    repository_id: int | None
    filters: dict
    created_at: datetime


class SavedViewIn(BaseModel):
    name: str
    view_kind: str
    repository_id: int | None = None
    filters: dict = Field(default_factory=dict)


class RenameIn(BaseModel):
    name: str


def _clean_name(name: str) -> str:
    cleaned = name.strip()
    if not cleaned:
        raise HTTPException(status_code=422, detail="View name must not be empty")
    return cleaned


def _to_out(view: SavedView) -> SavedViewOut:
    return SavedViewOut(
        id=view.id,
        name=view.name,
        view_kind=view.view_kind,
        repository_id=view.repository_id,
        filters=view.filters,
        created_at=view.created_at,
    )


@router.get("/views", response_model=list[SavedViewOut])
async def list_views(session: AsyncSession = Depends(get_session)) -> list[SavedViewOut]:
    views = (
        (
            await session.execute(
                select(SavedView).order_by(
                    SavedView.created_at.desc(), SavedView.id.desc()
                )
            )
        )
        .scalars()
        .all()
    )
    return [_to_out(view) for view in views]


@router.post("/views", response_model=SavedViewOut, status_code=201)
async def create_view(
    body: SavedViewIn, session: AsyncSession = Depends(get_session)
) -> SavedViewOut:
    name = _clean_name(body.name)
    if body.view_kind not in VIEW_KINDS:
        raise HTTPException(
            status_code=422, detail=f"Unknown view kind: {body.view_kind}"
        )
    if body.view_kind == "matrix" and body.repository_id is None:
        raise HTTPException(
            status_code=422, detail="Matrix views require a repository"
        )
    if body.repository_id is not None:
        repo = (
            await session.execute(
                select(Repository).where(Repository.id == body.repository_id)
            )
        ).scalar_one_or_none()
        if repo is None:
            raise HTTPException(status_code=404, detail="Unknown repository")
    view = SavedView(
        name=name,
        view_kind=body.view_kind,
        repository_id=body.repository_id,
        filters=body.filters,
    )
    session.add(view)
    try:
        await session.commit()
    except IntegrityError:
        await session.rollback()
        raise HTTPException(
            status_code=409,
            detail=f'A {body.view_kind} view named "{name}" already exists',
        ) from None
    await session.refresh(view)
    return _to_out(view)


@router.patch("/views/{view_id}", response_model=SavedViewOut)
async def rename_view(
    view_id: int, body: RenameIn, session: AsyncSession = Depends(get_session)
) -> SavedViewOut:
    name = _clean_name(body.name)
    view = (
        await session.execute(select(SavedView).where(SavedView.id == view_id))
    ).scalar_one_or_none()
    if view is None:
        raise HTTPException(status_code=404, detail="Unknown view")
    view.name = name
    try:
        await session.commit()
    except IntegrityError:
        await session.rollback()
        raise HTTPException(
            status_code=409,
            detail=f'A {view.view_kind} view named "{name}" already exists',
        ) from None
    await session.refresh(view)
    return _to_out(view)


@router.delete("/views/{view_id}", status_code=204)
async def delete_view(
    view_id: int, session: AsyncSession = Depends(get_session)
) -> Response:
    await session.execute(delete(SavedView).where(SavedView.id == view_id))
    await session.commit()
    return Response(status_code=204)
```

- [ ] **Step 4: Register the router**

In `backend/app/main.py`, add the import (keep the block alphabetical):

```python
from app.routers.views import router as views_router
```

and after `app.include_router(triage_router)`:

```python
app.include_router(views_router)
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd backend && python -m pytest tests/test_api_views.py -v`
Expected: 6 passed.

- [ ] **Step 6: Full backend suite + lint**

Run: `cd backend && python -m pytest -q && python -m ruff check .`
Expected: all pass (was 185 before this branch; now 194), no lint errors.

- [ ] **Step 7: Commit**

```bash
git add backend/app/routers/views.py backend/app/main.py backend/tests/test_api_views.py
git commit -m "feat: saved views CRUD API (GET/POST/PATCH/DELETE /views)"
```

---

### Task 3: Frontend — pure filter model (`lib/matrix-filters.ts`) + views client helpers (`lib/views.ts`) [tier: haiku]

**Files:**
- Create: `frontend/src/lib/matrix-filters.ts`
- Create: `frontend/src/lib/views.ts`

**Interfaces:**
- Consumes: `getJson` from `frontend/src/lib/api.ts` (exists).
- Produces (used by Tasks 4–7):
  - `type MatrixFilters = { types: TypeFilter[]; readiness: ReadinessBucket | null }`
  - `parseFilters(params)`, `filtersToSearch(repoId, filters): string`, `filtersFromJson(value): MatrixFilters`
  - `applyFilters(items, filters)`, `matchesFilters(item, filters)`, `hasActiveFilters(filters)`, `filterSummary(filters): string`
  - `ISSUE_TYPE_FILTERS`, `TYPE_LABEL`, `READINESS_ORDER`, `READINESS_BUCKETS`, `NO_FILTERS`
  - `type SavedView`, `VIEWS_KEY`, `fetchViews()`, `savedViewHref(view): string`

These are pure modules with no component code; they are exercised by the Playwright specs in Tasks 4–7 (no separate unit-test framework exists in this repo).

- [ ] **Step 1: Create `frontend/src/lib/matrix-filters.ts`** (exact content):

```ts
export const ISSUE_TYPE_FILTERS = [
  "bug",
  "feature",
  "debt",
  "question",
  "docs",
  "unclassified",
] as const;
export type TypeFilter = (typeof ISSUE_TYPE_FILTERS)[number];

export const TYPE_LABEL: Record<TypeFilter, string> = {
  bug: "Bug",
  feature: "Feature",
  debt: "Debt",
  question: "Question",
  docs: "Docs",
  unclassified: "Unclassified",
};

export const READINESS_ORDER = ["ready", "almost", "needswork", "unscored"] as const;
export type ReadinessBucket = (typeof READINESS_ORDER)[number];

export const READINESS_BUCKETS: Record<ReadinessBucket, { label: string }> = {
  ready: { label: "Ready (≥80)" },
  almost: { label: "Almost (50–79)" },
  needswork: { label: "Needs work (<50)" },
  unscored: { label: "Unscored" },
};

export type MatrixFilters = {
  /** Empty = all types. */
  types: TypeFilter[];
  /** null = any readiness. */
  readiness: ReadinessBucket | null;
};

export const NO_FILTERS: MatrixFilters = { types: [], readiness: null };

type ParamSource = { get(name: string): string | null };

/** Unknown or malformed values are ignored — never a crash. */
export function parseFilters(params: ParamSource): MatrixFilters {
  const types = (params.get("types") ?? "")
    .split(",")
    .filter((t): t is TypeFilter =>
      (ISSUE_TYPE_FILTERS as readonly string[]).includes(t),
    );
  const rawReadiness = params.get("readiness");
  const readiness = (READINESS_ORDER as readonly string[]).includes(rawReadiness ?? "")
    ? (rawReadiness as ReadinessBucket)
    : null;
  return { types: [...new Set(types)], readiness };
}

export function filtersToSearch(repoId: number | null, filters: MatrixFilters): string {
  const params = new URLSearchParams();
  if (repoId != null) params.set("repo_id", String(repoId));
  if (filters.types.length) params.set("types", filters.types.join(","));
  if (filters.readiness) params.set("readiness", filters.readiness);
  return params.toString();
}

/** Sanitize a saved view's JSONB filters payload (untrusted shape). */
export function filtersFromJson(value: unknown): MatrixFilters {
  const obj = (typeof value === "object" && value !== null ? value : {}) as {
    types?: unknown;
    readiness?: unknown;
  };
  const types = Array.isArray(obj.types)
    ? obj.types.filter(
        (t): t is TypeFilter =>
          typeof t === "string" &&
          (ISSUE_TYPE_FILTERS as readonly string[]).includes(t),
      )
    : [];
  const readiness =
    typeof obj.readiness === "string" &&
    (READINESS_ORDER as readonly string[]).includes(obj.readiness)
      ? (obj.readiness as ReadinessBucket)
      : null;
  return { types: [...new Set(types)], readiness };
}

export function hasActiveFilters(filters: MatrixFilters): boolean {
  return filters.types.length > 0 || filters.readiness != null;
}

type Filterable = { issue_type: string | null; readiness_score: number | null };

export function matchesFilters(item: Filterable, filters: MatrixFilters): boolean {
  if (filters.types.length) {
    const t = item.issue_type ?? "unclassified";
    if (!(filters.types as readonly string[]).includes(t)) return false;
  }
  if (filters.readiness) {
    const s = item.readiness_score;
    if (filters.readiness === "unscored") return s == null;
    if (s == null) return false;
    if (filters.readiness === "ready") return s >= 80;
    if (filters.readiness === "almost") return s >= 50 && s < 80;
    return s < 50; // needswork
  }
  return true;
}

export function applyFilters<T extends Filterable>(
  items: T[],
  filters: MatrixFilters,
): T[] {
  return items.filter((item) => matchesFilters(item, filters));
}

/** Human-readable summary, e.g. "Bug, Debt · Ready (≥80)". */
export function filterSummary(filters: MatrixFilters): string {
  const parts: string[] = [];
  if (filters.types.length) {
    parts.push(filters.types.map((t) => TYPE_LABEL[t]).join(", "));
  }
  if (filters.readiness) {
    parts.push(READINESS_BUCKETS[filters.readiness].label);
  }
  return parts.length ? parts.join(" · ") : "All issues";
}
```

- [ ] **Step 2: Create `frontend/src/lib/views.ts`** (exact content):

```ts
import { getJson } from "./api";
import { filtersFromJson, filtersToSearch } from "./matrix-filters";

export type SavedView = {
  id: number;
  name: string;
  view_kind: string;
  repository_id: number | null;
  filters: unknown;
  created_at: string;
};

export const VIEWS_KEY = ["views"] as const;

export function fetchViews(): Promise<SavedView[]> {
  return getJson<SavedView[]>("/api/backend/views");
}

/** Deep link that re-applies a matrix view's repo + filters. */
export function savedViewHref(view: SavedView): string {
  const search = filtersToSearch(view.repository_id, filtersFromJson(view.filters));
  return search ? `/plan/matrix?${search}` : "/plan/matrix";
}
```

- [ ] **Step 3: Lint + typecheck**

Run: `cd frontend && npm run lint && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/lib/matrix-filters.ts frontend/src/lib/views.ts
git commit -m "feat: matrix filter model + saved-view client helpers"
```

---

### Task 4: Frontend — filter chips on the matrix [tier: sonnet]

**Files:**
- Create: `frontend/src/app/plan/matrix/filter-chips.tsx`
- Modify: `frontend/src/app/plan/matrix/matrix-client.tsx`
- Test: `frontend/e2e/matrix-filters.spec.ts`

**Interfaces:**
- Consumes: everything from `lib/matrix-filters` (Task 3); existing `toPlotted`, `MatrixPayload` from `./matrix-types`.
- Produces: `FilterChips({ filters, onChange }: { filters: MatrixFilters; onChange: (next: MatrixFilters) => void })`. Test ids: `type-chip`, `type-panel`, `readiness-chip`, `readiness-panel`, `readiness-<bucket>`, `clear-filters`, `filter-count`, `filter-empty`, `clear-filters-empty`. Task 5 inserts its button into the same control row.

- [ ] **Step 1: Write the failing e2e spec**

Create `frontend/e2e/matrix-filters.spec.ts`:

```ts
import { expect, test, type Page, type Route } from "@playwright/test";

const item = (over: Partial<Record<string, unknown>> = {}) => ({
  issue_id: 1,
  number: 42,
  title: "Fix token refresh",
  urgency: 80,
  importance: 70,
  factors: [],
  issue_type: "bug",
  component: "auth",
  readiness_score: 80,
  labels: [],
  assignees: [],
  estimate: 3,
  pinned: false,
  pinned_urgency: null,
  pinned_importance: null,
  scored_at: "2026-07-20T00:00:00Z",
  model: "test-model",
  ...over,
});

// 4 plottable issues across types/readiness + 1 awaiting priority scores
const payload = {
  items: [
    item(),
    item({ issue_id: 2, number: 43, title: "Docs typo", urgency: 20, importance: 15, issue_type: "docs", readiness_score: 30 }),
    item({ issue_id: 3, number: 45, title: "No readiness yet", urgency: 60, importance: 55, issue_type: "feature", readiness_score: null }),
    item({ issue_id: 4, number: 46, title: "Mystery issue", urgency: 40, importance: 60, issue_type: null, readiness_score: 55 }),
    item({ issue_id: 5, number: 44, title: "Awaiting analysis", urgency: null, importance: null }),
  ],
  total: 5,
  scored: 4,
  unscored: 1,
};

async function stubMatrix(page: Page) {
  await page.route(/\/api\/backend\/repositories$/, (route: Route) =>
    route.fulfill({ json: [{ id: 500, full_name: "patelmj/mehova" }] }),
  );
  await page.route(/\/api\/backend\/repositories\/500\/priority$/, (route: Route) =>
    route.fulfill({ json: payload }),
  );
  await page.route(/\/api\/backend\/views$/, (route: Route) =>
    route.fulfill({ json: [] }),
  );
}

test("type chip filters chart and queue together", async ({ page }) => {
  await stubMatrix(page);
  await page.goto("/plan/matrix");
  await expect(page.getByTestId("bubble-42")).toBeVisible();
  await expect(page.getByTestId("bubble-43")).toBeVisible();

  await page.getByTestId("type-chip").click();
  await page.getByTestId("type-panel").getByRole("checkbox", { name: "Bug" }).check();

  await expect(page.getByTestId("bubble-42")).toBeVisible();
  await expect(page.getByTestId("bubble-43")).not.toBeVisible();
  await expect(page.getByTestId("bubble-45")).not.toBeVisible();
  await expect(page.getByTestId("filter-count")).toHaveText("1 of 4 shown");
  await expect(page.getByTestId("qgroup-dofirst")).toContainText("#42");
  await expect(page.getByTestId("qgroup-reconsider")).not.toBeVisible();
  await expect(page).toHaveURL(/types=bug/);
  await expect(page.getByTestId("type-chip")).toContainText("Type: Bug");
});

test("unclassified type bucket matches null issue_type", async ({ page }) => {
  await stubMatrix(page);
  await page.goto("/plan/matrix");
  await page.getByTestId("type-chip").click();
  await page
    .getByTestId("type-panel")
    .getByRole("checkbox", { name: "Unclassified" })
    .check();
  await expect(page.getByTestId("bubble-46")).toBeVisible();
  await expect(page.getByTestId("bubble-42")).not.toBeVisible();
  await expect(page.getByTestId("filter-count")).toHaveText("1 of 4 shown");
});

test("readiness buckets filter by score ranges and unscored", async ({ page }) => {
  await stubMatrix(page);
  await page.goto("/plan/matrix");

  await page.getByTestId("readiness-chip").click();
  await page.getByTestId("readiness-ready").click();
  await expect(page.getByTestId("bubble-42")).toBeVisible();
  await expect(page.getByTestId("bubble-43")).not.toBeVisible();
  await expect(page).toHaveURL(/readiness=ready/);

  await page.getByTestId("readiness-chip").click();
  await page.getByTestId("readiness-unscored").click();
  await expect(page.getByTestId("bubble-45")).toBeVisible();
  await expect(page.getByTestId("bubble-42")).not.toBeVisible();
});

test("filters survive reload via URL and invalid params are ignored", async ({ page }) => {
  await stubMatrix(page);
  await page.goto("/plan/matrix?repo_id=500&types=docs");
  await expect(page.getByTestId("bubble-43")).toBeVisible();
  await expect(page.getByTestId("bubble-42")).not.toBeVisible();
  await page.reload();
  await expect(page.getByTestId("bubble-43")).toBeVisible();
  await expect(page.getByTestId("bubble-42")).not.toBeVisible();
  await expect(page.getByTestId("type-chip")).toContainText("Type: Docs");

  // fully invalid params → treated as absent: all 4 plottable bubbles, no count chip
  await page.goto("/plan/matrix?repo_id=500&types=zebra&readiness=nope");
  await expect(page.getByTestId("bubble-42")).toBeVisible();
  await expect(page.getByTestId("bubble-43")).toBeVisible();
  await expect(page.getByTestId("bubble-45")).toBeVisible();
  await expect(page.getByTestId("bubble-46")).toBeVisible();
  await expect(page.getByTestId("filter-count")).not.toBeVisible();
});

test("empty filter result shows its own state; clear restores", async ({ page }) => {
  await stubMatrix(page);
  await page.goto("/plan/matrix?repo_id=500&types=question");
  await expect(page.getByTestId("filter-empty")).toBeVisible();
  await expect(page.getByTestId("filter-empty")).toContainText(
    "No issues match these filters",
  );
  await page.getByTestId("clear-filters-empty").click();
  await expect(page.getByTestId("bubble-42")).toBeVisible();
  await expect(page).not.toHaveURL(/types=/);
});

test("clear-filters chip resets all filters", async ({ page }) => {
  await stubMatrix(page);
  await page.goto("/plan/matrix?repo_id=500&types=bug&readiness=ready");
  await expect(page.getByTestId("clear-filters")).toBeVisible();
  await page.getByTestId("clear-filters").click();
  await expect(page.getByTestId("bubble-43")).toBeVisible();
  await expect(page).not.toHaveURL(/types=|readiness=/);
  await expect(page.getByTestId("clear-filters")).not.toBeVisible();
});

test("chips stay legible after theme toggle", async ({ page }) => {
  await stubMatrix(page);
  await page.goto("/plan/matrix?repo_id=500&types=bug");
  await expect(async () => {
    await page.getByRole("button", { name: /switch to light mode/i }).click();
    await expect(page.locator("html")).toHaveAttribute("data-mode", "light", {
      timeout: 1_000,
    });
  }).toPass();
  await expect(page.getByTestId("type-chip")).toBeVisible();
  await expect(page.getByTestId("readiness-chip")).toBeVisible();
});
```

- [ ] **Step 2: Run spec to verify it fails**

Run: `cd frontend && npx playwright test e2e/matrix-filters.spec.ts`
Expected: FAIL — `type-chip` test id not found.

- [ ] **Step 3: Create `frontend/src/app/plan/matrix/filter-chips.tsx`** (exact content):

```tsx
"use client";

import { useEffect, useRef, useState } from "react";
import {
  ISSUE_TYPE_FILTERS,
  READINESS_BUCKETS,
  READINESS_ORDER,
  TYPE_LABEL,
  hasActiveFilters,
  NO_FILTERS,
  type MatrixFilters,
  type TypeFilter,
} from "../../../lib/matrix-filters";

const chipBase = "rounded-lg border px-2.5 py-1.5 transition-all duration-150";
const chipIdle =
  "border-(--color-border) bg-(--color-surface) text-(--color-text-muted) hover:text-(--color-text)";
const chipActive = "border-transparent bg-(--accent-tint) font-medium text-(--color-primary)";
const panel =
  "absolute left-0 top-full z-30 mt-1 flex min-w-44 flex-col gap-0.5 rounded-lg border border-(--color-border) bg-(--color-surface) p-1.5 shadow-(--shadow-card)";

export function FilterChips({
  filters,
  onChange,
}: {
  filters: MatrixFilters;
  onChange: (next: MatrixFilters) => void;
}) {
  const [openPanel, setOpenPanel] = useState<"type" | "readiness" | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!openPanel) return;
    const onPointerDown = (e: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpenPanel(null);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpenPanel(null);
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [openPanel]);

  const toggleType = (t: TypeFilter) => {
    const has = filters.types.includes(t);
    onChange({
      ...filters,
      types: has ? filters.types.filter((x) => x !== t) : [...filters.types, t],
    });
  };

  const typeLabel =
    filters.types.length === 0
      ? "Type: All"
      : `Type: ${filters.types.map((t) => TYPE_LABEL[t]).join(", ")}`;
  const readinessLabel = filters.readiness
    ? `Readiness: ${READINESS_BUCKETS[filters.readiness].label}`
    : "Readiness: Any";

  return (
    <div ref={rootRef} className="flex items-center gap-2">
      <div className="relative">
        <button
          type="button"
          data-testid="type-chip"
          aria-expanded={openPanel === "type"}
          className={`${chipBase} ${filters.types.length ? chipActive : chipIdle}`}
          onClick={() => setOpenPanel(openPanel === "type" ? null : "type")}
        >
          {typeLabel}
        </button>
        {openPanel === "type" ? (
          <div className={panel} data-testid="type-panel">
            {ISSUE_TYPE_FILTERS.map((t) => (
              <label
                key={t}
                className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1 transition-all duration-150 hover:bg-(--accent-tint)"
              >
                <input
                  type="checkbox"
                  checked={filters.types.includes(t)}
                  onChange={() => toggleType(t)}
                />
                <span>{TYPE_LABEL[t]}</span>
              </label>
            ))}
          </div>
        ) : null}
      </div>

      <div className="relative">
        <button
          type="button"
          data-testid="readiness-chip"
          aria-expanded={openPanel === "readiness"}
          className={`${chipBase} ${filters.readiness ? chipActive : chipIdle}`}
          onClick={() => setOpenPanel(openPanel === "readiness" ? null : "readiness")}
        >
          {readinessLabel}
        </button>
        {openPanel === "readiness" ? (
          <div className={panel} data-testid="readiness-panel">
            <button
              type="button"
              data-testid="readiness-any"
              className={`rounded-md px-2 py-1 text-left transition-all duration-150 hover:bg-(--accent-tint) ${
                filters.readiness == null ? "text-(--color-primary)" : ""
              }`}
              onClick={() => {
                onChange({ ...filters, readiness: null });
                setOpenPanel(null);
              }}
            >
              Any
            </button>
            {READINESS_ORDER.map((bucket) => (
              <button
                key={bucket}
                type="button"
                data-testid={`readiness-${bucket}`}
                className={`rounded-md px-2 py-1 text-left transition-all duration-150 hover:bg-(--accent-tint) ${
                  filters.readiness === bucket ? "text-(--color-primary)" : ""
                }`}
                onClick={() => {
                  onChange({ ...filters, readiness: bucket });
                  setOpenPanel(null);
                }}
              >
                {READINESS_BUCKETS[bucket].label}
              </button>
            ))}
          </div>
        ) : null}
      </div>

      {hasActiveFilters(filters) ? (
        <button
          type="button"
          data-testid="clear-filters"
          className="text-(--color-text-muted) transition-all duration-150 hover:text-(--color-text)"
          onClick={() => onChange(NO_FILTERS)}
        >
          Clear filters
        </button>
      ) : null}
    </div>
  );
}
```

- [ ] **Step 4: Wire filters into `matrix-client.tsx`**

Apply these exact changes to `frontend/src/app/plan/matrix/matrix-client.tsx`:

(a) Add imports after the existing `matrix-types` import block:

```tsx
import { FilterChips } from "./filter-chips";
import {
  applyFilters,
  filtersToSearch,
  hasActiveFilters,
  parseFilters,
  type MatrixFilters,
} from "../../../lib/matrix-filters";
```

(b) After the `const matrixKey = ["matrix", repoId] as const;` line, add:

```tsx
  const filters = parseFilters(searchParams);

  const navigateWith = useCallback(
    (nextRepoId: number | null, nextFilters: MatrixFilters) => {
      const search = filtersToSearch(nextRepoId, nextFilters);
      router.replace(search ? `/plan/matrix?${search}` : "/plan/matrix", {
        scroll: false,
      });
    },
    [router],
  );
```

(c) Replace the repo `<select>`'s `onChange` handler with:

```tsx
          onChange={(e) =>
            navigateWith(e.target.value ? Number(e.target.value) : null, filters)
          }
```

(d) Directly after the closing `</select>` tag, insert:

```tsx
        <FilterChips
          filters={filters}
          onChange={(next) => navigateWith(repoId, next)}
        />
        {filtersActive && data ? (
          <span className="text-(--color-text-muted)" data-testid="filter-count">
            {plotted.length} of {allPlottedCount} shown
          </span>
        ) : null}
```

(e) Replace the three data-derivation lines

```tsx
  const items = data?.items ?? [];
  const plotted = toPlotted(items);
  const selected = items.find((item) => item.issue_id === selectedId) ?? null;
```

with:

```tsx
  const items = data?.items ?? [];
  const filtersActive = hasActiveFilters(filters);
  const filtered = applyFilters(items, filters);
  const plotted = toPlotted(filtered);
  const allPlottedCount = toPlotted(items).length;
  const selected = filtered.find((item) => item.issue_id === selectedId) ?? null;
```

(f) In the render chain, insert a filter-empty branch BEFORE the existing `plotted.length === 0` branch (order matters — the filter state must win when filters are active):

```tsx
      ) : filtersActive && plotted.length === 0 ? (
        <div
          className={`${card} flex flex-col items-center gap-1.5 px-6 py-16 text-center`}
          data-testid="filter-empty"
        >
          <div className="text-sm font-medium">No issues match these filters</div>
          <div className="text-(--color-text-muted)">
            {allPlottedCount} scored issue{allPlottedCount === 1 ? "" : "s"} hidden by
            the current filters.
          </div>
          <button
            type="button"
            data-testid="clear-filters-empty"
            className="mt-2 rounded-lg border border-(--color-border) px-2.5 py-1 text-(--color-primary) transition-all duration-150 hover:bg-(--accent-tint)"
            onClick={() => navigateWith(repoId, { types: [], readiness: null })}
          >
            Clear filters
          </button>
        </div>
      ) : plotted.length === 0 ? (
```

- [ ] **Step 5: Run the new spec**

Run: `cd frontend && npx playwright test e2e/matrix-filters.spec.ts`
Expected: 7 passed.

- [ ] **Step 6: Run the existing matrix spec (regression) + lint**

Run: `cd frontend && npx playwright test e2e/matrix.spec.ts && npm run lint`
Expected: 5 passed, no lint errors. (The existing spec sets no filter params, so behavior is unchanged.)

- [ ] **Step 7: Commit**

```bash
git add frontend/src/app/plan/matrix/filter-chips.tsx frontend/src/app/plan/matrix/matrix-client.tsx frontend/e2e/matrix-filters.spec.ts
git commit -m "feat: matrix filter chips (type + readiness bucket) with URL state"
```

---

### Task 5: Frontend — Save view button + popover [tier: sonnet]

**Files:**
- Create: `frontend/src/app/plan/matrix/save-view.tsx`
- Modify: `frontend/src/app/plan/matrix/matrix-client.tsx` (two insertions)
- Test: `frontend/e2e/save-view.spec.ts`

**Interfaces:**
- Consumes: `MatrixFilters`, `hasActiveFilters` (Task 3); `VIEWS_KEY`, `SavedView` (Task 3); `sendJson` from `lib/api`.
- Produces: `SaveViewButton({ repoId, filters })` rendered in the matrix control row. Test ids: `save-view`, `save-view-popover`, `save-view-name`, `save-view-submit`, `save-view-error`. POST body shape: `{name, view_kind: "matrix", repository_id, filters: {types, readiness}}`.

- [ ] **Step 1: Write the failing e2e spec**

Create `frontend/e2e/save-view.spec.ts`:

```ts
import { expect, test, type Page, type Route } from "@playwright/test";

const item = (over: Partial<Record<string, unknown>> = {}) => ({
  issue_id: 1,
  number: 42,
  title: "Fix token refresh",
  urgency: 80,
  importance: 70,
  factors: [],
  issue_type: "bug",
  component: "auth",
  readiness_score: 80,
  labels: [],
  assignees: [],
  estimate: 3,
  pinned: false,
  pinned_urgency: null,
  pinned_importance: null,
  scored_at: "2026-07-20T00:00:00Z",
  model: "test-model",
  ...over,
});

const payload = {
  items: [
    item(),
    item({ issue_id: 2, number: 43, title: "Docs typo", urgency: 20, importance: 15, issue_type: "docs", readiness_score: 30 }),
  ],
  total: 2,
  scored: 2,
  unscored: 0,
};

async function stubMatrix(page: Page, posts: unknown[], postStatus = 201) {
  await page.route(/\/api\/backend\/repositories$/, (route: Route) =>
    route.fulfill({ json: [{ id: 500, full_name: "patelmj/mehova" }] }),
  );
  await page.route(/\/api\/backend\/repositories\/500\/priority$/, (route: Route) =>
    route.fulfill({ json: payload }),
  );
  await page.route(/\/api\/backend\/views$/, (route: Route) => {
    if (route.request().method() === "POST") {
      const body = route.request().postDataJSON();
      if (postStatus !== 201) {
        return route.fulfill({
          status: postStatus,
          json: { detail: 'A matrix view named "Ready bugs" already exists' },
        });
      }
      posts.push(body);
      return route.fulfill({
        status: 201,
        json: { id: 1, created_at: "2026-07-21T00:00:00Z", ...body },
      });
    }
    return route.fulfill({ json: [] });
  });
}

test("save view is disabled without filters, posts snapshot with filters", async ({ page }) => {
  const posts: unknown[] = [];
  await stubMatrix(page, posts);
  await page.goto("/plan/matrix");
  await expect(page.getByTestId("save-view")).toBeDisabled();

  await page.goto("/plan/matrix?repo_id=500&types=bug&readiness=ready");
  await expect(page.getByTestId("save-view")).toBeEnabled();
  await page.getByTestId("save-view").click();
  await page.getByTestId("save-view-name").fill("Ready bugs");
  await page.getByTestId("save-view-submit").click();

  await expect.poll(() => posts.length).toBe(1);
  expect(posts[0]).toEqual({
    name: "Ready bugs",
    view_kind: "matrix",
    repository_id: 500,
    filters: { types: ["bug"], readiness: "ready" },
  });
  await expect(page.getByTestId("save-view-popover")).not.toBeVisible();
});

test("duplicate name shows the API error inline", async ({ page }) => {
  await stubMatrix(page, [], 409);
  await page.goto("/plan/matrix?repo_id=500&types=bug");
  await page.getByTestId("save-view").click();
  await page.getByTestId("save-view-name").fill("Ready bugs");
  await page.getByTestId("save-view-submit").click();
  await expect(page.getByTestId("save-view-error")).toContainText("already exists");
  await expect(page.getByTestId("save-view-popover")).toBeVisible();
});
```

- [ ] **Step 2: Run spec to verify it fails**

Run: `cd frontend && npx playwright test e2e/save-view.spec.ts`
Expected: FAIL — `save-view` test id not found.

- [ ] **Step 3: Create `frontend/src/app/plan/matrix/save-view.tsx`** (exact content):

```tsx
"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { sendJson } from "../../../lib/api";
import { hasActiveFilters, type MatrixFilters } from "../../../lib/matrix-filters";
import { VIEWS_KEY, type SavedView } from "../../../lib/views";

const panel =
  "absolute right-0 top-full z-30 mt-1 flex w-60 flex-col gap-2 rounded-lg border border-(--color-border) bg-(--color-surface) p-2.5 shadow-(--shadow-card)";

export function SaveViewButton({
  repoId,
  filters,
}: {
  repoId: number | null;
  filters: MatrixFilters;
}) {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const rootRef = useRef<HTMLDivElement>(null);
  const canSave = repoId != null && hasActiveFilters(filters);

  const mutation = useMutation({
    mutationFn: () =>
      sendJson<SavedView>("/api/backend/views", "POST", {
        name: name.trim(),
        view_kind: "matrix",
        repository_id: repoId,
        filters: { types: filters.types, readiness: filters.readiness },
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

- [ ] **Step 4: Render it in `matrix-client.tsx`**

(a) Add import next to the `FilterChips` import:

```tsx
import { SaveViewButton } from "./save-view";
```

(b) Insert directly after the `{filtersActive && data ? (...filter-count...) : null}` block added in Task 4 (still inside the control row `div`):

```tsx
        <SaveViewButton repoId={repoId} filters={filters} />
```

- [ ] **Step 5: Run spec to verify it passes**

Run: `cd frontend && npx playwright test e2e/save-view.spec.ts`
Expected: 2 passed.

- [ ] **Step 6: Lint**

Run: `cd frontend && npm run lint`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add frontend/src/app/plan/matrix/save-view.tsx frontend/src/app/plan/matrix/matrix-client.tsx frontend/e2e/save-view.spec.ts
git commit -m "feat: save filtered matrix state as a named view"
```

---

### Task 6: Frontend — dynamic saved views in the sidebar [tier: sonnet]

**Files:**
- Modify: `frontend/src/components/sidenav.tsx`
- Modify: `frontend/src/components/app-shell.tsx` (Suspense wrap — REQUIRED, see Global Constraints)
- Test: `frontend/e2e/saved-views-nav.spec.ts`

**Interfaces:**
- Consumes: `fetchViews`, `savedViewHref`, `VIEWS_KEY` from `lib/views` (Task 3).
- Produces: sidebar sub-links `saved-view-link-<id>` under the "Saved Views" nav item; real count pill on that item. Fetch failure → static link only (design §6).

- [ ] **Step 1: Write the failing e2e spec**

Create `frontend/e2e/saved-views-nav.spec.ts`:

```ts
import { expect, test, type Page, type Route } from "@playwright/test";

const item = (over: Partial<Record<string, unknown>> = {}) => ({
  issue_id: 1,
  number: 42,
  title: "Fix token refresh",
  urgency: 80,
  importance: 70,
  factors: [],
  issue_type: "bug",
  component: "auth",
  readiness_score: 80,
  labels: [],
  assignees: [],
  estimate: 3,
  pinned: false,
  pinned_urgency: null,
  pinned_importance: null,
  scored_at: "2026-07-20T00:00:00Z",
  model: "test-model",
  ...over,
});

const matrixPayload = {
  items: [
    item(),
    item({ issue_id: 2, number: 43, title: "Docs typo", urgency: 20, importance: 15, issue_type: "docs", readiness_score: 30 }),
  ],
  total: 2,
  scored: 2,
  unscored: 0,
};

const views = [
  {
    id: 1,
    name: "Ready bugs",
    view_kind: "matrix",
    repository_id: 500,
    filters: { types: ["bug"], readiness: "ready" },
    created_at: "2026-07-21T00:00:00Z",
  },
  {
    id: 2,
    name: "Docs pile",
    view_kind: "matrix",
    repository_id: 500,
    filters: { types: ["docs"], readiness: null },
    created_at: "2026-07-20T00:00:00Z",
  },
];

async function stubAll(page: Page) {
  await page.route(/\/api\/backend\/repositories$/, (route: Route) =>
    route.fulfill({ json: [{ id: 500, full_name: "patelmj/mehova" }] }),
  );
  await page.route(/\/api\/backend\/repositories\/500\/priority$/, (route: Route) =>
    route.fulfill({ json: matrixPayload }),
  );
  await page.route(/\/api\/backend\/views$/, (route: Route) =>
    route.fulfill({ json: views }),
  );
}

test("sidebar lists saved views with a live count pill", async ({ page }) => {
  await stubAll(page);
  await page.goto("/plan/matrix");
  const nav = page.getByRole("navigation", { name: "Primary" });
  await expect(nav.getByTestId("saved-view-link-1")).toHaveText("Ready bugs");
  await expect(nav.getByTestId("saved-view-link-2")).toHaveText("Docs pile");
  await expect(nav.getByTestId("views-count")).toHaveText("2");
});

test("clicking a saved view navigates and applies its filters", async ({ page }) => {
  await stubAll(page);
  await page.goto("/plan/matrix");
  await page.getByTestId("saved-view-link-1").click();
  await expect(page).toHaveURL(/plan\/matrix\?repo_id=500&types=bug&readiness=ready/);
  await expect(page.getByTestId("bubble-42")).toBeVisible();
  await expect(page.getByTestId("bubble-43")).not.toBeVisible();
  await expect(page.getByTestId("type-chip")).toContainText("Type: Bug");
  // active highlight on the current view
  await expect(page.getByTestId("saved-view-link-1")).toHaveClass(/text-\(--color-primary\)/);
});

test("views fetch failure leaves static sidebar intact", async ({ page }) => {
  await page.route(/\/api\/backend\/views$/, (route: Route) =>
    route.fulfill({ status: 500, json: { detail: "boom" } }),
  );
  await page.goto("/");
  const nav = page.getByRole("navigation", { name: "Primary" });
  await expect(nav.getByRole("link", { name: "Saved Views" })).toBeVisible();
  await expect(nav.getByTestId("saved-view-link-1")).not.toBeVisible();
  await nav.getByRole("link", { name: "Saved Views" }).click();
  await expect(page).toHaveURL("/views");
});
```

- [ ] **Step 2: Run spec to verify it fails**

Run: `cd frontend && npx playwright test e2e/saved-views-nav.spec.ts`
Expected: FAIL — `saved-view-link-1` not found.

- [ ] **Step 3: Rewrite `frontend/src/components/sidenav.tsx`** (complete new content):

```tsx
"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { fetchViews, savedViewHref, VIEWS_KEY } from "../lib/views";

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

const childLink = (active: boolean) =>
  `flex items-center rounded-lg py-1.5 pl-7 transition-all duration-150 ${
    active
      ? "bg-(--accent-tint) font-medium text-(--color-primary)"
      : "text-(--color-text-muted) hover:bg-(--accent-tint) hover:text-(--color-text)"
  }`;

export function Sidenav() {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const search = searchParams.toString();
  const currentUrl = search ? `${pathname}?${search}` : pathname;

  const { data: views } = useQuery({
    queryKey: VIEWS_KEY,
    queryFn: fetchViews,
    retry: false,
    staleTime: 30_000,
  });
  const matrixViews = (views ?? []).filter((view) => view.view_kind === "matrix");

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
                  {href === "/views" && matrixViews.length > 0 ? (
                    <ul className="mt-0.5 flex flex-col gap-0.5">
                      {matrixViews.map((view) => {
                        const viewHref = savedViewHref(view);
                        return (
                          <li key={view.id}>
                            <Link
                              href={viewHref}
                              data-testid={`saved-view-link-${view.id}`}
                              className={childLink(currentUrl === viewHref)}
                            >
                              {view.name}
                            </Link>
                          </li>
                        );
                      })}
                    </ul>
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

- [ ] **Step 4: Wrap Sidenav in Suspense in `app-shell.tsx`**

`useSearchParams()` in Sidenav requires a Suspense boundary or `next build` fails prerendering (Global Constraints). In `frontend/src/components/app-shell.tsx`:

(a) Add to imports:

```tsx
import { Suspense } from "react";
```

(b) Replace `<Sidenav />` with:

```tsx
        <Suspense fallback={<nav aria-label="Primary" />}>
          <Sidenav />
        </Suspense>
```

- [ ] **Step 5: Run the new spec + shell regression**

Run: `cd frontend && npx playwright test e2e/saved-views-nav.spec.ts e2e/shell.spec.ts`
Expected: 3 + 5 passed. (shell.spec's "Saved Views" link locator still resolves uniquely — no stubbed views exist in those tests, so no sub-links render.)

- [ ] **Step 6: Build check (prerender must not break)**

Run: `cd frontend && npm run build`
Expected: build succeeds — this is the step that catches a missing Suspense boundary.

- [ ] **Step 7: Lint + commit**

Run: `cd frontend && npm run lint`

```bash
git add frontend/src/components/sidenav.tsx frontend/src/components/app-shell.tsx frontend/e2e/saved-views-nav.spec.ts
git commit -m "feat: saved views listed live in the sidebar with count pill"
```

---

### Task 7: Frontend — real `/views` page (list, rename, delete) [tier: sonnet]

**Files:**
- Modify: `frontend/src/app/views/page.tsx`
- Create: `frontend/src/app/views/views-client.tsx`
- Test: `frontend/e2e/views.spec.ts`

**Interfaces:**
- Consumes: `fetchViews`, `savedViewHref`, `VIEWS_KEY`, `SavedView` (Task 3); `filterSummary`, `filtersFromJson` (Task 3); `getJson`, `sendJson` (`lib/api`).
- Produces: `/views` page. Test ids: `views-list`, `view-row-<id>`, `view-open-<id>`, `view-rename-<id>`, `view-rename-input`, `view-rename-save`, `view-delete-<id>`, `views-error`, `views-empty`.

- [ ] **Step 1: Write the failing e2e spec**

Create `frontend/e2e/views.spec.ts`:

```ts
import { expect, test, type Page, type Route } from "@playwright/test";

type View = {
  id: number;
  name: string;
  view_kind: string;
  repository_id: number | null;
  filters: unknown;
  created_at: string;
};

const initialViews: View[] = [
  {
    id: 1,
    name: "Ready bugs",
    view_kind: "matrix",
    repository_id: 500,
    filters: { types: ["bug"], readiness: "ready" },
    created_at: "2026-07-21T00:00:00Z",
  },
  {
    id: 2,
    name: "Docs pile",
    view_kind: "matrix",
    repository_id: 500,
    filters: { types: ["docs"], readiness: null },
    created_at: "2026-07-20T00:00:00Z",
  },
];

/** Stateful stub: PATCH/DELETE mutate the list the GET returns. */
async function stubViews(page: Page, calls: { patches: unknown[]; deletes: number[] }) {
  let views: View[] = structuredClone(initialViews);
  await page.route(/\/api\/backend\/repositories$/, (route: Route) =>
    route.fulfill({ json: [{ id: 500, full_name: "patelmj/mehova" }] }),
  );
  await page.route(/\/api\/backend\/views$/, (route: Route) =>
    route.fulfill({ json: views }),
  );
  await page.route(/\/api\/backend\/views\/\d+$/, (route: Route) => {
    const id = Number(route.request().url().split("/").pop());
    if (route.request().method() === "PATCH") {
      const body = route.request().postDataJSON() as { name: string };
      calls.patches.push({ id, ...body });
      views = views.map((v) => (v.id === id ? { ...v, name: body.name } : v));
      return route.fulfill({ json: views.find((v) => v.id === id) });
    }
    calls.deletes.push(id);
    views = views.filter((v) => v.id !== id);
    return route.fulfill({ status: 204, body: "" });
  });
}

test("lists views with repo, summary, and open link", async ({ page }) => {
  await stubViews(page, { patches: [], deletes: [] });
  await page.goto("/views");
  const row = page.getByTestId("view-row-1");
  await expect(row).toContainText("Ready bugs");
  await expect(row).toContainText("patelmj/mehova");
  await expect(row).toContainText("Bug · Ready (≥80)");
  await expect(row).toContainText("Matrix");
  await expect(page.getByTestId("view-open-1")).toHaveAttribute(
    "href",
    "/plan/matrix?repo_id=500&types=bug&readiness=ready",
  );
  await expect(page.getByTestId("view-row-2")).toContainText("Docs pile");
});

test("rename sends PATCH and updates the list", async ({ page }) => {
  const calls = { patches: [] as unknown[], deletes: [] as number[] };
  await stubViews(page, calls);
  await page.goto("/views");
  await page.getByTestId("view-rename-1").click();
  await page.getByTestId("view-rename-input").fill("Bug backlog");
  await page.getByTestId("view-rename-save").click();
  await expect.poll(() => calls.patches.length).toBe(1);
  expect(calls.patches[0]).toEqual({ id: 1, name: "Bug backlog" });
  await expect(page.getByTestId("view-row-1")).toContainText("Bug backlog");
});

test("delete is two-step and removes the row", async ({ page }) => {
  const calls = { patches: [] as unknown[], deletes: [] as number[] };
  await stubViews(page, calls);
  await page.goto("/views");
  await page.getByTestId("view-delete-1").click();
  await expect(page.getByTestId("view-delete-1")).toContainText("Confirm");
  await page.getByTestId("view-delete-1").click();
  await expect.poll(() => calls.deletes).toEqual([1]);
  await expect(page.getByTestId("view-row-1")).not.toBeVisible();
  await expect(page.getByTestId("view-row-2")).toBeVisible();
});

test("empty state keeps the original copy", async ({ page }) => {
  await page.route(/\/api\/backend\/repositories$/, (route: Route) =>
    route.fulfill({ json: [] }),
  );
  await page.route(/\/api\/backend\/views$/, (route: Route) =>
    route.fulfill({ json: [] }),
  );
  await page.goto("/views");
  await expect(page.getByTestId("views-empty")).toContainText("No saved views yet");
});
```

- [ ] **Step 2: Run spec to verify it fails**

Run: `cd frontend && npx playwright test e2e/views.spec.ts`
Expected: FAIL — `view-row-1` not found (placeholder page renders).

- [ ] **Step 3: Create `frontend/src/app/views/views-client.tsx`** (exact content):

```tsx
"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useState } from "react";
import { getJson, sendJson } from "../../lib/api";
import { filterSummary, filtersFromJson } from "../../lib/matrix-filters";
import { fetchViews, savedViewHref, VIEWS_KEY, type SavedView } from "../../lib/views";

const card =
  "rounded-[14px] border border-(--color-border) bg-(--color-surface) shadow-(--shadow-card)";

type Repo = { id: number; full_name: string };

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

  const renameMutation = useMutation({
    mutationFn: ({ id, name }: { id: number; name: string }) =>
      sendJson<SavedView>(`/api/backend/views/${id}`, "PATCH", { name }),
    onSuccess: () => {
      setRenamingId(null);
      setActionError(null);
      queryClient.invalidateQueries({ queryKey: VIEWS_KEY });
    },
    onError: (err) => setActionError(err.message),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: number) =>
      sendJson<undefined>(`/api/backend/views/${id}`, "DELETE"),
    onSuccess: () => {
      setConfirmDeleteId(null);
      setActionError(null);
      queryClient.invalidateQueries({ queryKey: VIEWS_KEY });
    },
    onError: (err) => setActionError(err.message),
  });

  const repoName = (id: number | null) =>
    repos?.find((repo) => repo.id === id)?.full_name ?? "—";

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
            Save any filtered table or board as a named view and it will be listed
            here.
          </div>
        </div>
      ) : (
        <ul className={`${card} divide-y divide-(--color-border)`} data-testid="views-list">
          {(views ?? []).map((view) => (
            <li
              key={view.id}
              className="flex items-center gap-3 px-4 py-3"
              data-testid={`view-row-${view.id}`}
            >
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
                      disabled={!renameValue.trim() || renameMutation.isPending}
                      className="rounded-lg bg-(--accent-tint) px-2.5 py-1 font-medium text-(--color-primary) transition-all duration-150 disabled:opacity-60"
                    >
                      Save
                    </button>
                    <button
                      type="button"
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
                      {view.view_kind === "matrix" ? "Matrix" : view.view_kind}
                    </span>
                  </div>
                )}
                <div className="truncate pt-0.5 text-(--color-text-muted)">
                  {repoName(view.repository_id)} ·{" "}
                  {filterSummary(filtersFromJson(view.filters))}
                </div>
              </div>
              <Link
                href={savedViewHref(view)}
                data-testid={`view-open-${view.id}`}
                className="rounded-lg border border-(--color-border) px-2.5 py-1 text-(--color-primary) transition-all duration-150 hover:bg-(--accent-tint)"
              >
                Open
              </Link>
              <button
                type="button"
                data-testid={`view-rename-${view.id}`}
                className="rounded-lg border border-(--color-border) px-2.5 py-1 text-(--color-text-muted) transition-all duration-150 hover:text-(--color-text)"
                onClick={() => {
                  setRenamingId(view.id);
                  setRenameValue(view.name);
                  setConfirmDeleteId(null);
                }}
              >
                Rename
              </button>
              <button
                type="button"
                data-testid={`view-delete-${view.id}`}
                className={`rounded-lg border px-2.5 py-1 transition-all duration-150 ${
                  confirmDeleteId === view.id
                    ? "border-(--color-danger) text-(--color-danger)"
                    : "border-(--color-border) text-(--color-text-muted) hover:text-(--color-text)"
                }`}
                onClick={() => {
                  if (confirmDeleteId === view.id) {
                    deleteMutation.mutate(view.id);
                  } else {
                    setConfirmDeleteId(view.id);
                    setRenamingId(null);
                  }
                }}
              >
                {confirmDeleteId === view.id ? "Confirm delete" : "Delete"}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
```

- [ ] **Step 4: Replace `frontend/src/app/views/page.tsx`** (complete new content):

```tsx
import { ViewsClient } from "./views-client";

export default function SavedViewsPage() {
  return <ViewsClient />;
}
```

- [ ] **Step 5: Run spec to verify it passes**

Run: `cd frontend && npx playwright test e2e/views.spec.ts`
Expected: 4 passed.

- [ ] **Step 6: Lint + commit**

Run: `cd frontend && npm run lint`

```bash
git add frontend/src/app/views/page.tsx frontend/src/app/views/views-client.tsx frontend/e2e/views.spec.ts
git commit -m "feat: real /views page — list, rename, delete saved views"
```

---

### Task 8: Full-suite verification + live smoke [tier: sonnet]

**Files:** none created — verification only. Fix-forward anything that fails, commit fixes individually.

- [ ] **Step 1: Backend suite + lint**

Run: `cd backend && python -m pytest -q && python -m ruff check .`
Expected: all tests pass (194), no lint errors.

- [ ] **Step 2: Frontend lint + typecheck + build**

Run: `cd frontend && npm run lint && npx tsc --noEmit && npm run build`
Expected: all clean. Build failure at prerender means a missing Suspense boundary (see Task 6 Step 4).

- [ ] **Step 3: Full e2e suite**

First: `docker stop issuelens-frontend-1` if it is running (stale container gotcha).
Run: `cd frontend && npx playwright test`
Expected: all specs pass (30 pre-existing + 16 new = 46).

- [ ] **Step 4: Live smoke against the real stack (Playwright CLI, not manual)**

```bash
docker compose up -d --build
```

Wait for healthy, confirm migration applied (compose `migrate` service exits 0; `docker compose logs migrate` shows upgrade to 0009). Then drive the real app with a throwaway Playwright script against http://localhost:3005 (real backend, no route stubs): apply a type filter on `/plan/matrix`, save a view named `smoke-<timestamp>`, verify it appears in the sidebar, click it, verify the URL + filtered chart, rename it on `/views`, delete it. Delete any leftover smoke views afterwards via `DELETE /api/backend/views/{id}`.

- [ ] **Step 5: Report**

Summarize pass/fail evidence (exact counts, exact commands run) — no success claims without command output (superpowers:verification-before-completion).

---

## Execution notes (for the orchestrating session)

- Branch `feat/matrix-filters-views` already exists with the spec committed.
- `/todos start 33` at kickoff; `/todos done 33` only after merge.
- SDD ledger: `.superpowers/sdd/progress.md` — add a "matrix filters + saved views" section; every task dispatch/review recorded there.
- Model tiers per task are tagged above. Every per-task review and fix re-review: **sonnet**. Final whole-branch review: **most-capable (Fable) — mandatory**.
- Implementer dispatches must tell subagents to grep for ALL call sites of anything they change, not rely on lists in this plan.
- Pause before opening the PR (CLAUDE.md PR-based review methodology).
