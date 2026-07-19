# Slice 4: Live Overview + Issues Table Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the 175 synced issues visible: a live Overview page (stat tiles + 30-day opened/closed chart) and a read-only, server-side sorted/filtered/paginated issues table at `/plan`, plus the slice-4 deferred-findings intake.

**Architecture:** Two new FastAPI routers (`/stats/overview`, `/issues` + `/issues/facets`) backed by SQL over the existing `issues`/`repositories` tables; migration 0003 adds intake FK indexes and partial indexes for the new queries. Frontend follows the repositories-page pattern: `"use client"` components with react-query fetching through the `/api/backend` proxy; table state serialized in the URL.

**Tech Stack:** FastAPI + SQLAlchemy async + Alembic; Next.js 16 app router + @tanstack/react-query + Tailwind v4 tokens; pytest + respx; Playwright.

**Spec:** `docs/superpowers/specs/2026-07-18-slice-4-live-overview-issues-table-design.md`

## Global Constraints

- Branch: `feat/live-overview` (already exists, contains the spec commit).
- Tokens-only colors. Tailwind v4 custom-property syntax is `bg-(--color-X)` / `text-(--color-X)` — **never** `bg-[--color-X]` (generates empty CSS).
- No new dependencies (frontend or backend).
- Every issue-facing query includes `WHERE is_pull_request = false`.
- Commit messages: no AI attribution, no Co-Authored-By lines.
- Inactive UI elements stay visible but muted — never hidden.
- Backend commands run from `backend/`: `uv run pytest -q`, `uv run ruff check .`, `uv run alembic upgrade head`.
- Frontend commands run from `frontend/`: `npm run lint`, `npm run test:e2e`.
- Prereq: `docker compose up -d` so Postgres (localhost:5432) and Redis are up; tests share the dev Postgres (`clean_db` truncates at test start).
- e2e specs mock backend routes with `page.route` **regex** patterns (glob `?` is a single-char wildcard and would match `/issues/facets`).
- Playwright e2e needs the frontend dev server; `playwright.config.ts` starts it automatically (`reuseExistingServer: true`).

---

### Task 1: Migration 0003 — intake FK indexes + issue query indexes

**Files:**
- Create: `backend/alembic/versions/0003_slice4_indexes.py`
- Modify: `backend/app/models.py`
- Test: `backend/tests/test_models.py`

**Interfaces:**
- Consumes: existing tables from migration 0002.
- Produces: index names `ix_repositories_installation_id`, `ix_sync_jobs_repository_id`, `ix_issues_gh_updated_at_not_pr`, `ix_issues_state_not_pr`. Later tasks' queries rely on these (no code references the names outside this task and its test).

- [ ] **Step 1: Write the failing test**

In `backend/tests/test_models.py`, change the sqlalchemy import line (currently `from sqlalchemy import select`) to:

```python
from sqlalchemy import select, text
```

and add at the end of the file (needs `get_engine` — extend the `app.db` import line to `from app.db import get_engine, get_sessionmaker`):

```python
async def test_slice4_indexes_exist():
    async with get_engine().connect() as conn:
        rows = await conn.execute(
            text("SELECT indexname FROM pg_indexes WHERE schemaname = 'public'")
        )
        names = {row[0] for row in rows}
    assert {
        "ix_repositories_installation_id",
        "ix_sync_jobs_repository_id",
        "ix_issues_gh_updated_at_not_pr",
        "ix_issues_state_not_pr",
    } <= names
```

- [ ] **Step 2: Run test to verify it fails**

Run (from `backend/`): `uv run pytest tests/test_models.py::test_slice4_indexes_exist -q`
Expected: FAIL — assertion error, the four names are missing from `pg_indexes`.

- [ ] **Step 3: Write the migration**

Create `backend/alembic/versions/0003_slice4_indexes.py`:

```python
"""slice-4 indexes: intake FK indexes + issue list query indexes"""

import sqlalchemy as sa
from alembic import op

revision = "0003"
down_revision = "0002"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_index("ix_repositories_installation_id", "repositories", ["installation_id"])
    op.create_index("ix_sync_jobs_repository_id", "sync_jobs", ["repository_id"])
    op.create_index(
        "ix_issues_gh_updated_at_not_pr",
        "issues",
        ["gh_updated_at"],
        postgresql_where=sa.text("NOT is_pull_request"),
    )
    op.create_index(
        "ix_issues_state_not_pr",
        "issues",
        ["state"],
        postgresql_where=sa.text("NOT is_pull_request"),
    )


def downgrade() -> None:
    op.drop_index("ix_issues_state_not_pr", table_name="issues")
    op.drop_index("ix_issues_gh_updated_at_not_pr", table_name="issues")
    op.drop_index("ix_sync_jobs_repository_id", table_name="sync_jobs")
    op.drop_index("ix_repositories_installation_id", table_name="repositories")
```

- [ ] **Step 4: Apply the migration**

Run (from `backend/`): `uv run alembic upgrade head`
Expected: `Running upgrade 0002 -> 0003` in the output, exit 0.

- [ ] **Step 5: Run test to verify it passes**

Run: `uv run pytest tests/test_models.py::test_slice4_indexes_exist -q`
Expected: PASS.

- [ ] **Step 6: Mirror the indexes in the ORM models**

In `backend/app/models.py`:

1. Extend the sqlalchemy import block with `Index` and `text` (final import list: `BigInteger, Boolean, DateTime, ForeignKey, Index, Integer, Text, UniqueConstraint, func, text`).
2. On `Repository.installation_id`, add `index=True`:

```python
    installation_id: Mapped[int] = mapped_column(
        BigInteger, ForeignKey("installations.id", ondelete="CASCADE"), index=True
    )
```

3. On `SyncJob.repository_id`, add `index=True`:

```python
    repository_id: Mapped[int] = mapped_column(
        BigInteger, ForeignKey("repositories.id", ondelete="CASCADE"), index=True
    )
```

4. Replace `Issue.__table_args__` with:

```python
    __table_args__ = (
        UniqueConstraint("repository_id", "number", name="uq_issues_repo_number"),
        Index(
            "ix_issues_gh_updated_at_not_pr",
            "gh_updated_at",
            postgresql_where=text("NOT is_pull_request"),
        ),
        Index(
            "ix_issues_state_not_pr",
            "state",
            postgresql_where=text("NOT is_pull_request"),
        ),
    )
```

- [ ] **Step 7: Run full backend suite + lint**

Run: `uv run pytest -q` then `uv run ruff check .`
Expected: all tests pass (32 + 1 new), ruff clean.

- [ ] **Step 8: Commit**

```bash
git add backend/alembic/versions/0003_slice4_indexes.py backend/app/models.py backend/tests/test_models.py
git commit -m "feat(db): migration 0003 - FK indexes and partial issue-list indexes"
```

---

### Task 2: Sync intake — ARQ `_job_id` dedup + missing sync tests

**Files:**
- Modify: `backend/app/routers/repositories.py` (the `trigger_sync` endpoint)
- Test: `backend/tests/test_api_repositories.py`, `backend/tests/test_sync.py`

**Interfaces:**
- Consumes: `get_arq_pool()` (unchanged), `sync_repository_issues` (unchanged).
- Produces: `POST /repositories/{id}/sync` now returns `{"queued": bool}` where `false` means an identical job is already queued (ARQ `_job_id` dedup). The frontend `repositories-client.tsx` already types the response as `{ queued: boolean }` — no frontend change needed.

- [ ] **Step 1: Write the failing tests**

In `backend/tests/test_api_repositories.py`, **replace** the existing `test_sync_enqueues` with the following, and add the two new tests after it:

```python
async def test_sync_enqueues_with_dedup_job_id(app_creds, clean_db, api, monkeypatch):  # noqa: F811
    await seed_repo()
    calls: list[tuple] = []

    class FakePool:
        async def enqueue_job(self, name, *args, **kwargs):
            calls.append((name, args, kwargs))
            return object()  # arq returns a Job when newly enqueued

    async def fake_pool():
        return FakePool()

    monkeypatch.setattr("app.routers.repositories.get_arq_pool", fake_pool)
    async with api as client:
        resp = await client.post("/repositories/500/sync?full=true")
    assert resp.status_code == 202
    assert resp.json() == {"queued": True}
    assert calls == [("sync_repository", (500, True), {"_job_id": "sync-repo-500"})]


async def test_sync_duplicate_returns_queued_false(app_creds, clean_db, api, monkeypatch):  # noqa: F811
    await seed_repo()

    class FakePool:
        async def enqueue_job(self, name, *args, **kwargs):
            return None  # arq returns None when _job_id already exists

    async def fake_pool():
        return FakePool()

    monkeypatch.setattr("app.routers.repositories.get_arq_pool", fake_pool)
    async with api as client:
        resp = await client.post("/repositories/500/sync")
    assert resp.status_code == 202
    assert resp.json() == {"queued": False}


async def test_sync_unconfigured_returns_503(clean_db, api):
    async with api as client:
        resp = await client.post("/repositories/1/sync")
    assert resp.status_code == 503
    assert "GitHub App not configured" in resp.json()["detail"]
```

In `backend/tests/test_sync.py`, add at the end of the file:

```python
@respx.mock
async def test_incremental_sync_sends_since(app_creds, clean_db):  # noqa: F811
    _token_route()
    route = respx.get("https://api.github.com/repos/patelmj/IssueLens/issues").mock(
        return_value=httpx.Response(200, json=[gh_issue(1, 1)])
    )
    async with get_sessionmaker()() as session:
        await seed(session)
        async with make_http_client() as client:
            await sync_repository_issues(session, client, 500)
            await sync_repository_issues(session, client, 500)
    first_params = dict(route.calls[0].request.url.params)
    assert "since" not in first_params
    second_params = dict(route.calls[-1].request.url.params)
    # last_synced_at after run 1 = gh_issue updated (2026-07-10T10:00Z) minus 5-min overlap
    assert second_params["since"] == "2026-07-10T09:55:00Z"
```

- [ ] **Step 2: Run tests to verify the right failures**

Run: `uv run pytest tests/test_api_repositories.py tests/test_sync.py -q`
Expected: `test_sync_enqueues_with_dedup_job_id` FAILS (no `_job_id` kwarg captured), `test_sync_duplicate_returns_queued_false` FAILS (`{"queued": True}` returned), `test_sync_unconfigured_returns_503` PASSES already (the endpoint checks config first — keep the test as an intake regression guard), `test_incremental_sync_sends_since` PASSES already (behavior existed, test was missing — keep it). Everything else still passes.

- [ ] **Step 3: Implement the dedup**

In `backend/app/routers/repositories.py`, replace the last three lines of `trigger_sync`:

```python
    pool = await get_arq_pool()
    job = await pool.enqueue_job(
        "sync_repository", repo_id, full, _job_id=f"sync-repo-{repo_id}"
    )
    return {"queued": job is not None}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `uv run pytest tests/test_api_repositories.py tests/test_sync.py -q`
Expected: all pass.

- [ ] **Step 5: Full suite, lint, commit**

Run: `uv run pytest -q && uv run ruff check .`
Expected: all pass, ruff clean.

```bash
git add backend/app/routers/repositories.py backend/tests/test_api_repositories.py backend/tests/test_sync.py
git commit -m "fix(sync): dedup concurrent repo syncs via arq _job_id; add missing sync tests"
```

---

### Task 3: `GET /stats/overview` endpoint

**Files:**
- Create: `backend/app/routers/stats.py`
- Modify: `backend/app/main.py`
- Test: `backend/tests/test_api_stats.py` (create)

**Interfaces:**
- Consumes: `Issue`, `Repository` models; `get_session` dependency.
- Produces: `GET /stats/overview` → `OverviewStats` JSON: `{connected_repos: int, open_issues: int, last_synced_at: datetime|null, top_repos: [{id, full_name, open_issues_count}], activity: [{date: "YYYY-MM-DD", opened: int, closed: int}]}`. `activity` is **sparse** (only days with activity, sorted ascending); the frontend fills gaps. Task 6/7 frontend types mirror this shape exactly.

- [ ] **Step 1: Write the failing tests**

Create `backend/tests/test_api_stats.py`:

```python
from datetime import datetime, timedelta, timezone

import pytest
from httpx import ASGITransport, AsyncClient

from app.db import get_sessionmaker
from app.main import app
from app.models import Installation, Issue, Repository

NOW = datetime.now(timezone.utc)


@pytest.fixture
def api():
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test")


async def seed_overview_data():
    async with get_sessionmaker()() as session:
        session.add(Installation(id=42, account_login="patelmj"))
        session.add(
            Repository(
                id=500, installation_id=42, full_name="patelmj/mehova",
                owner="patelmj", name="mehova", open_issues_count=2,
                last_synced_at=NOW - timedelta(hours=1),
            )
        )
        session.add(
            Repository(
                id=501, installation_id=42, full_name="patelmj/IssueLens",
                owner="patelmj", name="IssueLens", open_issues_count=1,
                last_synced_at=NOW,
            )
        )
        session.add(
            Issue(
                id=1, repository_id=500, number=1, title="open recent", state="open",
                gh_created_at=NOW - timedelta(days=2), gh_updated_at=NOW,
            )
        )
        session.add(
            Issue(
                id=2, repository_id=500, number=2, title="open old", state="open",
                gh_created_at=NOW - timedelta(days=90), gh_updated_at=NOW,
            )
        )
        session.add(
            Issue(
                id=3, repository_id=500, number=3, title="closed in window", state="closed",
                gh_created_at=NOW - timedelta(days=90), gh_updated_at=NOW,
                gh_closed_at=NOW - timedelta(days=1),
            )
        )
        session.add(
            Issue(
                id=4, repository_id=501, number=4, title="a PR", state="open",
                is_pull_request=True,
                gh_created_at=NOW - timedelta(days=2), gh_updated_at=NOW,
            )
        )
        await session.commit()


async def test_overview_stats_empty_db(clean_db, api):
    async with api as client:
        resp = await client.get("/stats/overview")
    assert resp.status_code == 200
    assert resp.json() == {
        "connected_repos": 0,
        "open_issues": 0,
        "last_synced_at": None,
        "top_repos": [],
        "activity": [],
    }


async def test_overview_stats_seeded(clean_db, api):
    await seed_overview_data()
    async with api as client:
        resp = await client.get("/stats/overview")
    body = resp.json()
    assert body["connected_repos"] == 2
    # open, non-PR issues only: ids 1 and 2 (3 is closed, 4 is a PR)
    assert body["open_issues"] == 2
    assert body["last_synced_at"] is not None
    assert [r["full_name"] for r in body["top_repos"]] == [
        "patelmj/mehova", "patelmj/IssueLens",
    ]
    # activity: opened = issue 1 only (issue 2 out of window, issue 4 is a PR);
    # closed = issue 3 only (created out of window but closed inside it)
    assert sum(d["opened"] for d in body["activity"]) == 1
    assert sum(d["closed"] for d in body["activity"]) == 1
    dates = [d["date"] for d in body["activity"]]
    assert dates == sorted(dates)
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `uv run pytest tests/test_api_stats.py -q`
Expected: both FAIL with 404 (route not registered).

- [ ] **Step 3: Implement the router**

Create `backend/app/routers/stats.py`:

```python
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends
from pydantic import BaseModel
from sqlalchemy import Date, cast, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db import get_session
from app.models import Issue, Repository

router = APIRouter(prefix="/stats", tags=["stats"])

ACTIVITY_DAYS = 30
TOP_REPOS_LIMIT = 5


class TopRepo(BaseModel):
    id: int
    full_name: str
    open_issues_count: int


class ActivityDay(BaseModel):
    date: str  # YYYY-MM-DD (UTC)
    opened: int
    closed: int


class OverviewStats(BaseModel):
    connected_repos: int
    open_issues: int
    last_synced_at: datetime | None
    top_repos: list[TopRepo]
    activity: list[ActivityDay]


@router.get("/overview", response_model=OverviewStats)
async def overview_stats(session: AsyncSession = Depends(get_session)) -> OverviewStats:
    connected_repos = (
        await session.execute(select(func.count()).select_from(Repository))
    ).scalar_one()
    open_issues = (
        await session.execute(
            select(func.count())
            .select_from(Issue)
            .where(Issue.state == "open", Issue.is_pull_request.is_(False))
        )
    ).scalar_one()
    last_synced_at = (
        await session.execute(select(func.max(Repository.last_synced_at)))
    ).scalar_one()
    top_rows = (
        await session.execute(
            select(Repository.id, Repository.full_name, Repository.open_issues_count)
            .order_by(Repository.open_issues_count.desc(), Repository.full_name)
            .limit(TOP_REPOS_LIMIT)
        )
    ).all()

    window_start = (datetime.now(timezone.utc) - timedelta(days=ACTIVITY_DAYS - 1)).replace(
        hour=0, minute=0, second=0, microsecond=0
    )
    opened_rows = (
        await session.execute(
            select(cast(Issue.gh_created_at, Date).label("day"), func.count())
            .where(Issue.is_pull_request.is_(False), Issue.gh_created_at >= window_start)
            .group_by("day")
        )
    ).all()
    closed_rows = (
        await session.execute(
            select(cast(Issue.gh_closed_at, Date).label("day"), func.count())
            .where(
                Issue.is_pull_request.is_(False),
                Issue.gh_closed_at.is_not(None),
                Issue.gh_closed_at >= window_start,
            )
            .group_by("day")
        )
    ).all()
    counts: dict[str, list[int]] = {}
    for day, n in opened_rows:
        counts.setdefault(day.isoformat(), [0, 0])[0] = n
    for day, n in closed_rows:
        counts.setdefault(day.isoformat(), [0, 0])[1] = n
    activity = [
        ActivityDay(date=day, opened=opened, closed=closed)
        for day, (opened, closed) in sorted(counts.items())
    ]
    return OverviewStats(
        connected_repos=connected_repos,
        open_issues=open_issues,
        last_synced_at=last_synced_at,
        top_repos=[
            TopRepo(id=row.id, full_name=row.full_name, open_issues_count=row.open_issues_count)
            for row in top_rows
        ],
        activity=activity,
    )
```

- [ ] **Step 4: Register the router**

In `backend/app/main.py`, add the import next to the existing router import and register it after the existing `include_router` line:

```python
from app.routers.stats import router as stats_router
```

```python
app.include_router(stats_router)
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `uv run pytest tests/test_api_stats.py -q`
Expected: 2 passed.

- [ ] **Step 6: Full suite, lint, commit**

Run: `uv run pytest -q && uv run ruff check .`
Expected: all pass, ruff clean.

```bash
git add backend/app/routers/stats.py backend/app/main.py backend/tests/test_api_stats.py
git commit -m "feat(api): GET /stats/overview - tiles, top repos, 30-day activity"
```

---

### Task 4: `GET /issues` list endpoint

**Files:**
- Create: `backend/app/routers/issues.py`
- Modify: `backend/app/main.py`
- Test: `backend/tests/test_api_issues.py` (create)

**Interfaces:**
- Consumes: `Issue`, `Repository` models; `get_session`.
- Produces: `GET /issues` with query params `repo_id: int|None`, `state: open|closed|all = open`, `label: str|None`, `assignee: str|None`, `q: str|None`, `sort: updated|created|comments|number|title = updated`, `order: asc|desc = desc`, `limit: int = 50 (1..100)`, `offset: int = 0 (>=0)`. Response `IssuePage`: `{items: [IssueOut], total: int, limit: int, offset: int}`; `IssueOut` = `{id, repository_id, repo_full_name, number, title, state, author_login, labels: [{name, color}], assignees: [str], milestone_title, comments_count, gh_created_at, gh_updated_at, gh_closed_at}`. Task 5 adds `/issues/facets` to this same router file. Task 8 frontend types mirror `IssuePage`/`IssueOut` exactly.

- [ ] **Step 1: Write the failing tests**

Create `backend/tests/test_api_issues.py`:

```python
from datetime import datetime, timedelta, timezone

import pytest
from httpx import ASGITransport, AsyncClient

from app.db import get_sessionmaker
from app.main import app
from app.models import Installation, Issue, Repository

NOW = datetime.now(timezone.utc)


@pytest.fixture
def api():
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test")


async def seed_issues():
    async with get_sessionmaker()() as session:
        session.add(Installation(id=42, account_login="patelmj"))
        session.add(
            Repository(id=500, installation_id=42, full_name="patelmj/mehova",
                       owner="patelmj", name="mehova")
        )
        session.add(
            Repository(id=501, installation_id=42, full_name="patelmj/IssueLens",
                       owner="patelmj", name="IssueLens")
        )
        session.add(
            Issue(
                id=1, repository_id=500, number=1, title="Alpha bug", state="open",
                author_login="patelmj",
                labels=[{"name": "bug", "color": "d73a4a"}], assignees=["patelmj"],
                comments_count=5,
                gh_created_at=NOW - timedelta(days=10),
                gh_updated_at=NOW - timedelta(days=1),
            )
        )
        session.add(
            Issue(
                id=2, repository_id=500, number=2, title="Beta feature", state="closed",
                author_login="octocat",
                labels=[{"name": "feature", "color": "a2eeef"}], assignees=[],
                comments_count=0,
                gh_created_at=NOW - timedelta(days=8),
                gh_updated_at=NOW - timedelta(days=2),
                gh_closed_at=NOW - timedelta(days=2),
            )
        )
        session.add(
            Issue(
                id=3, repository_id=500, number=3, title="Gamma PR", state="open",
                is_pull_request=True,
                labels=[{"name": "prlabel", "color": "ffffff"}], assignees=["ghost"],
                gh_created_at=NOW - timedelta(days=3),
                gh_updated_at=NOW - timedelta(hours=1),
            )
        )
        session.add(
            Issue(
                id=4, repository_id=501, number=1, title="Delta task", state="open",
                author_login="octocat",
                labels=[{"name": "bug", "color": "d73a4a"}], assignees=["octocat"],
                comments_count=2,
                gh_created_at=NOW - timedelta(days=5),
                gh_updated_at=NOW - timedelta(hours=3),
            )
        )
        await session.commit()


async def get_body(api, url: str) -> dict:
    async with api as client:
        resp = await client.get(url)
    assert resp.status_code == 200
    return resp.json()


async def test_default_lists_open_non_pr_sorted_by_updated_desc(clean_db, api):
    await seed_issues()
    body = await get_body(api, "/issues")
    assert body["total"] == 2
    assert [i["title"] for i in body["items"]] == ["Delta task", "Alpha bug"]
    assert body["items"][0]["repo_full_name"] == "patelmj/IssueLens"
    assert body["limit"] == 50 and body["offset"] == 0


async def test_state_all_excludes_prs(clean_db, api):
    await seed_issues()
    body = await get_body(api, "/issues?state=all")
    assert body["total"] == 3
    assert all(i["title"] != "Gamma PR" for i in body["items"])


async def test_repo_filter(clean_db, api):
    await seed_issues()
    body = await get_body(api, "/issues?repo_id=501")
    assert [i["title"] for i in body["items"]] == ["Delta task"]


async def test_label_filter(clean_db, api):
    await seed_issues()
    body = await get_body(api, "/issues?state=all&label=feature")
    assert [i["title"] for i in body["items"]] == ["Beta feature"]


async def test_assignee_filter(clean_db, api):
    await seed_issues()
    body = await get_body(api, "/issues?assignee=octocat")
    assert [i["title"] for i in body["items"]] == ["Delta task"]


async def test_q_matches_title_case_insensitive(clean_db, api):
    await seed_issues()
    body = await get_body(api, "/issues?q=alpha")
    assert [i["title"] for i in body["items"]] == ["Alpha bug"]


async def test_numeric_q_matches_number(clean_db, api):
    await seed_issues()
    body = await get_body(api, "/issues?state=all&q=2")
    assert [i["title"] for i in body["items"]] == ["Beta feature"]


async def test_sort_by_comments_desc(clean_db, api):
    await seed_issues()
    body = await get_body(api, "/issues?sort=comments")
    assert [i["comments_count"] for i in body["items"]] == [5, 2]


async def test_pagination(clean_db, api):
    await seed_issues()
    body = await get_body(api, "/issues?limit=1&offset=1")
    assert body["total"] == 2
    assert [i["title"] for i in body["items"]] == ["Alpha bug"]
    assert body["limit"] == 1 and body["offset"] == 1


async def test_bad_params_are_422(clean_db, api):
    async with api as client:
        assert (await client.get("/issues?state=bogus")).status_code == 422
        assert (await client.get("/issues?sort=bogus")).status_code == 422
        assert (await client.get("/issues?limit=500")).status_code == 422
        assert (await client.get("/issues?offset=-1")).status_code == 422
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `uv run pytest tests/test_api_issues.py -q`
Expected: all FAIL with 404 (route not registered).

- [ ] **Step 3: Implement the router**

Create `backend/app/routers/issues.py`:

```python
from datetime import datetime
from typing import Literal

from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel
from sqlalchemy import Select, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db import get_session
from app.models import Issue, Repository

router = APIRouter(prefix="/issues", tags=["issues"])

SORT_COLUMNS = {
    "updated": Issue.gh_updated_at,
    "created": Issue.gh_created_at,
    "comments": Issue.comments_count,
    "number": Issue.number,
    "title": Issue.title,
}

ISSUE_FIELDS = (
    "id", "repository_id", "number", "title", "state", "author_login",
    "labels", "assignees", "milestone_title", "comments_count",
    "gh_created_at", "gh_updated_at", "gh_closed_at",
)


class IssueOut(BaseModel):
    id: int
    repository_id: int
    repo_full_name: str
    number: int
    title: str
    state: str
    author_login: str
    labels: list[dict]
    assignees: list[str]
    milestone_title: str | None
    comments_count: int
    gh_created_at: datetime
    gh_updated_at: datetime
    gh_closed_at: datetime | None


class IssuePage(BaseModel):
    items: list[IssueOut]
    total: int
    limit: int
    offset: int


def _escape_like(raw: str) -> str:
    return raw.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")


def _filtered_query(
    repo_id: int | None,
    state: str,
    label: str | None,
    assignee: str | None,
    q: str | None,
) -> Select:
    query = (
        select(Issue, Repository.full_name)
        .join(Repository, Issue.repository_id == Repository.id)
        .where(Issue.is_pull_request.is_(False))
    )
    if repo_id is not None:
        query = query.where(Issue.repository_id == repo_id)
    if state != "all":
        query = query.where(Issue.state == state)
    if label:
        query = query.where(Issue.labels.contains([{"name": label}]))
    if assignee:
        query = query.where(Issue.assignees.contains([assignee]))
    if q:
        clause = Issue.title.ilike(f"%{_escape_like(q)}%")
        if q.isdigit():
            clause = clause | (Issue.number == int(q))
        query = query.where(clause)
    return query


@router.get("", response_model=IssuePage)
async def list_issues(
    session: AsyncSession = Depends(get_session),
    repo_id: int | None = None,
    state: Literal["open", "closed", "all"] = "open",
    label: str | None = None,
    assignee: str | None = None,
    q: str | None = None,
    sort: Literal["updated", "created", "comments", "number", "title"] = "updated",
    order: Literal["asc", "desc"] = "desc",
    limit: int = Query(50, ge=1, le=100),
    offset: int = Query(0, ge=0),
) -> IssuePage:
    query = _filtered_query(repo_id, state, label, assignee, q)
    total = (
        await session.execute(select(func.count()).select_from(query.subquery()))
    ).scalar_one()
    column = SORT_COLUMNS[sort]
    ordered = query.order_by(
        column.asc() if order == "asc" else column.desc(), Issue.id
    )
    rows = (await session.execute(ordered.limit(limit).offset(offset))).all()
    items = [
        IssueOut(
            repo_full_name=full_name,
            **{field: getattr(issue, field) for field in ISSUE_FIELDS},
        )
        for issue, full_name in rows
    ]
    return IssuePage(items=items, total=total, limit=limit, offset=offset)
```

- [ ] **Step 4: Register the router**

In `backend/app/main.py`, add next to the other router imports/registrations:

```python
from app.routers.issues import router as issues_router
```

```python
app.include_router(issues_router)
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `uv run pytest tests/test_api_issues.py -q`
Expected: 10 passed.

- [ ] **Step 6: Full suite, lint, commit**

Run: `uv run pytest -q && uv run ruff check .`
Expected: all pass, ruff clean.

```bash
git add backend/app/routers/issues.py backend/app/main.py backend/tests/test_api_issues.py
git commit -m "feat(api): GET /issues - server-side filter, sort, pagination"
```

---

### Task 5: `GET /issues/facets` endpoint

**Files:**
- Modify: `backend/app/routers/issues.py`
- Test: `backend/tests/test_api_issues.py`

**Interfaces:**
- Consumes: the `issues` table's `labels` (list of `{name, color}`) and `assignees` (list of str) JSONB columns.
- Produces: `GET /issues/facets?repo_id=<optional int>` → `{"labels": [{"name": str, "color": str}], "assignees": [str]}`, both sorted ascending, PRs excluded. Task 9's toolbar consumes this shape.

- [ ] **Step 1: Write the failing tests**

Add at the end of `backend/tests/test_api_issues.py`:

```python
async def test_facets_all_repos(clean_db, api):
    await seed_issues()
    body = await get_body(api, "/issues/facets")
    assert [lb["name"] for lb in body["labels"]] == ["bug", "feature"]
    assert body["labels"][0]["color"] == "d73a4a"
    # PR label "prlabel" and PR assignee "ghost" are excluded
    assert body["assignees"] == ["octocat", "patelmj"]


async def test_facets_scoped_to_repo(clean_db, api):
    await seed_issues()
    body = await get_body(api, "/issues/facets?repo_id=501")
    assert [lb["name"] for lb in body["labels"]] == ["bug"]
    assert body["assignees"] == ["octocat"]
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `uv run pytest tests/test_api_issues.py -k facets -q`
Expected: both FAIL. Note the failure mode: `/issues/facets` currently routes to nothing — FastAPI returns 404.

- [ ] **Step 3: Implement facets**

In `backend/app/routers/issues.py`, add `text` to the sqlalchemy import (`from sqlalchemy import Select, func, select, text`) and append at the end of the file:

```python
class LabelFacet(BaseModel):
    name: str
    color: str


class FacetsOut(BaseModel):
    labels: list[LabelFacet]
    assignees: list[str]


@router.get("/facets", response_model=FacetsOut)
async def issue_facets(
    session: AsyncSession = Depends(get_session),
    repo_id: int | None = None,
) -> FacetsOut:
    repo_clause = "AND repository_id = :repo_id" if repo_id is not None else ""
    params = {"repo_id": repo_id} if repo_id is not None else {}
    label_rows = (
        await session.execute(
            text(
                "SELECT elem->>'name' AS name, min(elem->>'color') AS color "
                "FROM issues, jsonb_array_elements(labels) AS elem "
                f"WHERE NOT is_pull_request {repo_clause} "
                "GROUP BY elem->>'name' ORDER BY elem->>'name'"
            ),
            params,
        )
    ).all()
    assignee_rows = (
        await session.execute(
            text(
                "SELECT DISTINCT elem AS login "
                "FROM issues, jsonb_array_elements_text(assignees) AS elem "
                f"WHERE NOT is_pull_request {repo_clause} "
                "ORDER BY elem"
            ),
            params,
        )
    ).all()
    return FacetsOut(
        labels=[LabelFacet(name=row.name, color=row.color or "") for row in label_rows],
        assignees=[row.login for row in assignee_rows],
    )
```

Note: `repo_clause` is one of two fixed literals and the value is a bound parameter — no injection surface. Route ordering: FastAPI matches `/issues/facets` before the parameterless `/issues` list because the list route has no path parameter — no conflict.

- [ ] **Step 4: Run tests to verify they pass**

Run: `uv run pytest tests/test_api_issues.py -q`
Expected: 12 passed.

- [ ] **Step 5: Full suite, lint, commit**

Run: `uv run pytest -q && uv run ruff check .`
Expected: all pass, ruff clean.

```bash
git add backend/app/routers/issues.py backend/tests/test_api_issues.py
git commit -m "feat(api): GET /issues/facets - distinct labels and assignees for filters"
```

---

### Task 6: Live Overview page (tiles + repos strip + empty state) and shared frontend helpers

**Files:**
- Create: `frontend/src/lib/api.ts`, `frontend/src/lib/time.ts`, `frontend/src/app/overview-client.tsx`
- Modify: `frontend/src/app/page.tsx`, `frontend/src/app/repositories/repositories-client.tsx`
- Test: `frontend/e2e/overview.spec.ts` (create), `frontend/e2e/repositories.spec.ts`

**Interfaces:**
- Consumes: `GET /api/backend/stats/overview` → the Task 3 `OverviewStats` shape.
- Produces: `getJson<T>(url, init?)` in `lib/api.ts` and `relativeTime(iso: string | null): string` in `lib/time.ts` — Tasks 7–9 import these. `OverviewClient` renders `data-testid="overview-content"`; the h1 is always `Overview` (shell.spec.ts depends on it).

- [ ] **Step 1: Extract shared helpers**

Create `frontend/src/lib/api.ts`:

```ts
export async function getJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { detail?: string } | null;
    throw new Error(body?.detail ?? `Request failed (${res.status})`);
  }
  return res.json() as Promise<T>;
}
```

Create `frontend/src/lib/time.ts`:

```ts
export function relativeTime(iso: string | null): string {
  if (!iso) return "never";
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}
```

- [ ] **Step 2: Point repositories-client at the shared helpers**

In `frontend/src/app/repositories/repositories-client.tsx`: delete the local `getJson` and `relativeTime` function definitions and add these imports after the react-query import:

```ts
import { getJson } from "../../lib/api";
import { relativeTime } from "../../lib/time";
```

- [ ] **Step 3: Write the Overview client**

Create `frontend/src/app/overview-client.tsx`:

```tsx
"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { getJson } from "../lib/api";
import { relativeTime } from "../lib/time";

export type ActivityDay = { date: string; opened: number; closed: number };

type TopRepo = { id: number; full_name: string; open_issues_count: number };

type OverviewStats = {
  connected_repos: number;
  open_issues: number;
  last_synced_at: string | null;
  top_repos: TopRepo[];
  activity: ActivityDay[];
};

const card =
  "rounded-[14px] border border-(--color-border) bg-(--color-surface) shadow-(--shadow-card)";

function StatTile({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className={`${card} flex flex-col gap-1 px-4 py-3`}>
      <div className="text-[10px] font-semibold tracking-[0.08em] text-(--color-text-muted) uppercase">
        {label}
      </div>
      <div className="text-2xl font-semibold tracking-[-0.01em]">{value}</div>
      {sub ? <div className="text-(--color-text-muted)">{sub}</div> : null}
    </div>
  );
}

export function OverviewClient() {
  const { data, error, isPending } = useQuery({
    queryKey: ["overview-stats"],
    queryFn: () => getJson<OverviewStats>("/api/backend/stats/overview"),
    refetchInterval: 30_000,
  });
  const top = data?.top_repos[0];

  return (
    <div className="flex flex-col gap-4" data-testid="overview-content">
      <div className="flex items-baseline gap-3">
        <h1 className="text-lg font-semibold tracking-[-0.01em]">Overview</h1>
        <span className="text-(--color-text-muted)">Your issue landscape at a glance</span>
      </div>

      {isPending ? (
        <div className={`${card} px-6 py-16 text-center text-(--color-text-muted)`}>
          Loading overview…
        </div>
      ) : error ? (
        <div className={`${card} px-6 py-16 text-center`}>
          <div className="text-sm font-medium">Backend unavailable</div>
          <div className="pt-1.5 text-(--color-text-muted)">{error.message}</div>
        </div>
      ) : !data || data.connected_repos === 0 ? (
        <div className={`${card} flex flex-col items-center gap-1.5 px-6 py-16 text-center`}>
          <div className="text-sm font-medium">
            Connect GitHub to see your issue landscape
          </div>
          <div className="max-w-md text-(--color-text-muted)">
            Install the IssueLens GitHub App and sync a repository — stats,
            activity, and the issues table light up from your real data.
          </div>
          <Link
            className="pt-2 text-(--color-primary) hover:underline"
            href="/repositories"
          >
            Go to Repositories →
          </Link>
        </div>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <StatTile label="Connected repos" value={String(data.connected_repos)} />
            <StatTile label="Open issues" value={String(data.open_issues)} />
            <StatTile label="Last synced" value={relativeTime(data.last_synced_at)} />
            <StatTile
              label="Biggest repo"
              value={top ? top.full_name.split("/")[1] : "—"}
              sub={top ? `${top.open_issues_count} open issues` : undefined}
            />
          </div>
          <div className={`${card} px-4 py-3`}>
            <div className="flex items-baseline justify-between pb-2">
              <span className="text-sm font-medium">Repositories</span>
              <Link
                href="/repositories"
                className="text-(--color-primary) hover:underline"
              >
                View all →
              </Link>
            </div>
            <ul className="flex flex-col gap-1.5">
              {data.top_repos.map((repo) => (
                <li key={repo.id} className="flex items-center gap-3">
                  <Link
                    href={`/plan?repo_id=${repo.id}`}
                    className="font-medium hover:text-(--color-primary)"
                  >
                    {repo.full_name}
                  </Link>
                  <span className="text-(--color-text-muted)">
                    {repo.open_issues_count} open
                  </span>
                </li>
              ))}
            </ul>
          </div>
        </>
      )}
    </div>
  );
}
```

- [ ] **Step 4: Replace the placeholder page**

Replace the full contents of `frontend/src/app/page.tsx` with:

```tsx
import { OverviewClient } from "./overview-client";

export default function OverviewPage() {
  return <OverviewClient />;
}
```

- [ ] **Step 5: Write the e2e specs**

Create `frontend/e2e/overview.spec.ts`:

```ts
import { expect, test } from "@playwright/test";

const stats = {
  connected_repos: 2,
  open_issues: 94,
  last_synced_at: new Date(Date.now() - 5 * 60_000).toISOString(),
  top_repos: [
    { id: 1, full_name: "patelmj/mehova", open_issues_count: 80 },
    { id: 2, full_name: "patelmj/IssueLens", open_issues_count: 14 },
  ],
  activity: [],
};

test("overview renders live stat tiles", async ({ page }) => {
  await page.route(/\/api\/backend\/stats\/overview/, (route) =>
    route.fulfill({ json: stats }),
  );
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Overview");
  await expect(page.getByText("94")).toBeVisible();
  await expect(page.getByText("patelmj/mehova")).toBeVisible();
  await expect(page.getByText("5m ago")).toBeVisible();
});

test("overview empty state points at repositories", async ({ page }) => {
  await page.route(/\/api\/backend\/stats\/overview/, (route) =>
    route.fulfill({
      json: {
        connected_repos: 0,
        open_issues: 0,
        last_synced_at: null,
        top_repos: [],
        activity: [],
      },
    }),
  );
  await page.goto("/");
  await expect(
    page.getByText("Connect GitHub to see your issue landscape"),
  ).toBeVisible();
  await expect(page.getByRole("link", { name: "Go to Repositories →" })).toBeVisible();
});
```

Add to `frontend/e2e/repositories.spec.ts` (the intake assertion — end of file):

```ts
test("repositories empty state shows Connect GitHub guidance", async ({ page }) => {
  await page.route(/\/api\/backend\/repositories$/, (route) =>
    route.fulfill({ json: [] }),
  );
  await page.goto("/repositories");
  await expect(page.getByText("Connect GitHub", { exact: true })).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Open GitHub App settings ↗" }),
  ).toBeVisible();
});
```

- [ ] **Step 6: Lint and run e2e**

Run (from `frontend/`): `npm run lint`
Expected: clean.

Run: `npm run test:e2e`
Expected: all specs pass, including the 3 pre-existing shell tests (the Overview h1 renders unconditionally, so `shell.spec.ts` stays green even with the real backend up or down).

- [ ] **Step 7: Commit**

```bash
git add frontend/src/lib/api.ts frontend/src/lib/time.ts frontend/src/app/overview-client.tsx frontend/src/app/page.tsx frontend/src/app/repositories/repositories-client.tsx frontend/e2e/overview.spec.ts frontend/e2e/repositories.spec.ts
git commit -m "feat(overview): live stat tiles and repo strip from synced data"
```

---

### Task 7: Activity chart (tokens + SVG component + Overview integration)

**Files:**
- Create: `frontend/src/components/activity-chart.tsx`
- Modify: `frontend/src/app/globals.css`, `frontend/src/app/overview-client.tsx`
- Test: `frontend/e2e/overview.spec.ts`

**Interfaces:**
- Consumes: `ActivityDay` type exported by `overview-client.tsx` (`{date, opened, closed}`, sparse) — re-declared locally here and imported *from this component* by overview-client after this task (single source of truth moves here).
- Produces: `<ActivityChart data={ActivityDay[]} />` — fills the 30-day window itself. New CSS tokens: `--chart-opened`, `--chart-closed`, `--chart-grid`, `--chart-axis` (both modes).

Palette note: series colors are the first two slots of the sketch-validated palette; re-validated for this 2-series use with the dataviz validator — all six checks PASS in light (`#2a78d6`,`#008300` on light surface) and dark (`#3987e5`,`#008300` on dark surface).

- [ ] **Step 1: Add chart tokens**

In `frontend/src/app/globals.css`, append inside the `:root {` block (after `--color-danger`):

```css
  --chart-opened: #2a78d6;
  --chart-closed: #008300;
  --chart-grid: #e7e6e1;
  --chart-axis: #c9c8c2;
```

and inside the `:root[data-mode="dark"] {` block:

```css
  --chart-opened: #3987e5;
  --chart-closed: #008300;
  --chart-grid: #2c2c2a;
  --chart-axis: #383835;
```

- [ ] **Step 2: Write the chart component**

Create `frontend/src/components/activity-chart.tsx`:

```tsx
"use client";

import { useMemo, useRef, useState, type PointerEvent } from "react";

export type ActivityDay = { date: string; opened: number; closed: number };

const W = 720;
const H = 180;
const PAD = { left: 30, right: 58, top: 12, bottom: 22 };
const DAYS = 30;

function fillDays(sparse: ActivityDay[]): ActivityDay[] {
  const byDate = new Map(sparse.map((d) => [d.date, d]));
  const start = new Date();
  start.setUTCHours(0, 0, 0, 0);
  start.setUTCDate(start.getUTCDate() - (DAYS - 1));
  const out: ActivityDay[] = [];
  for (let i = 0; i < DAYS; i++) {
    const d = new Date(start);
    d.setUTCDate(start.getUTCDate() + i);
    const key = d.toISOString().slice(0, 10);
    out.push(byDate.get(key) ?? { date: key, opened: 0, closed: 0 });
  }
  return out;
}

function LegendSwatch({ color, label }: { color: string; label: string }) {
  return (
    <span className="flex items-center gap-1.5">
      <span
        className="inline-block h-2 w-2 rounded-full"
        style={{ background: color }}
      />
      <span className="text-(--color-text-muted)">{label}</span>
    </span>
  );
}

export function ActivityChart({ data }: { data: ActivityDay[] }) {
  const days = useMemo(() => fillDays(data), [data]);
  const [hover, setHover] = useState<number | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);

  const max = Math.max(1, ...days.map((d) => Math.max(d.opened, d.closed)));
  const x = (i: number) =>
    PAD.left + (i * (W - PAD.left - PAD.right)) / (days.length - 1);
  const y = (v: number) =>
    H - PAD.bottom - (v * (H - PAD.top - PAD.bottom)) / max;
  const path = (key: "opened" | "closed") =>
    days
      .map((d, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(d[key]).toFixed(1)}`)
      .join("");

  const last = days[days.length - 1];
  const yOpenedEnd = y(last.opened);
  const yClosedEndRaw = y(last.closed);
  const yClosedEnd =
    Math.abs(yOpenedEnd - yClosedEndRaw) < 12
      ? yClosedEndRaw >= yOpenedEnd
        ? yOpenedEnd + 12
        : yOpenedEnd - 12
      : yClosedEndRaw;

  const onMove = (e: PointerEvent<SVGSVGElement>) => {
    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect) return;
    const px = ((e.clientX - rect.left) / rect.width) * W;
    const i = Math.round(
      ((px - PAD.left) / (W - PAD.left - PAD.right)) * (days.length - 1),
    );
    setHover(Math.max(0, Math.min(days.length - 1, i)));
  };

  const hovered = hover === null ? null : days[hover];
  const tooltipLeftPct = hover === null ? 0 : Math.min((x(hover) / W) * 100, 78);

  return (
    <div className="relative">
      <div className="flex items-center gap-4 pb-2">
        <LegendSwatch color="var(--chart-opened)" label="Opened" />
        <LegendSwatch color="var(--chart-closed)" label="Closed" />
      </div>
      <svg
        ref={svgRef}
        viewBox={`0 0 ${W} ${H}`}
        className="w-full"
        role="img"
        aria-label="Issues opened and closed per day, last 30 days"
        onPointerMove={onMove}
        onPointerLeave={() => setHover(null)}
      >
        {[0, 0.5, 1].map((t) => (
          <g key={t}>
            <line
              x1={PAD.left}
              x2={W - PAD.right}
              y1={y(t * max)}
              y2={y(t * max)}
              stroke="var(--chart-grid)"
              strokeWidth="1"
            />
            <text
              x={PAD.left - 6}
              y={y(t * max) + 3}
              textAnchor="end"
              fontSize="9"
              fill="var(--color-text-muted)"
            >
              {Math.round(t * max)}
            </text>
          </g>
        ))}
        <text x={PAD.left} y={H - 6} fontSize="9" fill="var(--color-text-muted)">
          {days[0].date}
        </text>
        <text
          x={W - PAD.right}
          y={H - 6}
          textAnchor="end"
          fontSize="9"
          fill="var(--color-text-muted)"
        >
          {last.date}
        </text>
        <path
          d={path("opened")}
          fill="none"
          stroke="var(--chart-opened)"
          strokeWidth="2"
          strokeLinejoin="round"
        />
        <path
          d={path("closed")}
          fill="none"
          stroke="var(--chart-closed)"
          strokeWidth="2"
          strokeLinejoin="round"
        />
        <text
          x={W - PAD.right + 6}
          y={yOpenedEnd + 3}
          fontSize="10"
          fill="var(--color-text)"
        >
          Opened
        </text>
        <text
          x={W - PAD.right + 6}
          y={yClosedEnd + 3}
          fontSize="10"
          fill="var(--color-text)"
        >
          Closed
        </text>
        {hover !== null && hovered ? (
          <g>
            <line
              x1={x(hover)}
              x2={x(hover)}
              y1={PAD.top}
              y2={H - PAD.bottom}
              stroke="var(--chart-axis)"
              strokeWidth="1"
            />
            <circle
              cx={x(hover)}
              cy={y(hovered.opened)}
              r="4"
              fill="var(--chart-opened)"
              stroke="var(--color-surface)"
              strokeWidth="2"
            />
            <circle
              cx={x(hover)}
              cy={y(hovered.closed)}
              r="4"
              fill="var(--chart-closed)"
              stroke="var(--color-surface)"
              strokeWidth="2"
            />
          </g>
        ) : null}
      </svg>
      {hovered ? (
        <div
          className="pointer-events-none absolute top-8 z-10 rounded-lg border border-(--color-border) bg-(--color-surface) px-2.5 py-1.5 shadow-(--shadow-card)"
          style={{ left: `calc(${tooltipLeftPct}% + 8px)` }}
        >
          <div className="text-(--color-text-muted)">{hovered.date}</div>
          <div>
            {hovered.opened} opened · {hovered.closed} closed
          </div>
        </div>
      ) : null}
      <table className="sr-only">
        <caption>Issues opened and closed per day, last 30 days</caption>
        <thead>
          <tr>
            <th>Date</th>
            <th>Opened</th>
            <th>Closed</th>
          </tr>
        </thead>
        <tbody>
          {days.map((d) => (
            <tr key={d.date}>
              <td>{d.date}</td>
              <td>{d.opened}</td>
              <td>{d.closed}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
```

- [ ] **Step 3: Integrate into Overview**

In `frontend/src/app/overview-client.tsx`:

1. Delete the local `export type ActivityDay = ...` line and import it from the component instead. Add:

```tsx
import { ActivityChart, type ActivityDay } from "../components/activity-chart";
```

2. Insert the chart card between the stat-tile grid and the Repositories card (inside the `<>...</>` fragment):

```tsx
          <div className={`${card} px-4 py-3`}>
            <div className="flex items-baseline justify-between pb-1">
              <span className="text-sm font-medium">Opened vs closed</span>
              <span className="text-(--color-text-muted)">last 30 days</span>
            </div>
            <ActivityChart data={data.activity} />
          </div>
```

- [ ] **Step 4: Extend the e2e assertion**

In `frontend/e2e/overview.spec.ts`, in the "overview renders live stat tiles" test: change the `activity: []` line of the `stats` fixture to include real days (dates relative to now so they land in the 30-day window):

```ts
  activity: [
    {
      date: new Date(Date.now() - 2 * 86_400_000).toISOString().slice(0, 10),
      opened: 3,
      closed: 1,
    },
    {
      date: new Date(Date.now() - 86_400_000).toISOString().slice(0, 10),
      opened: 0,
      closed: 2,
    },
  ],
```

and add to the end of that test:

```ts
  await expect(
    page.getByRole("img", { name: /issues opened and closed per day/i }),
  ).toBeVisible();
```

- [ ] **Step 5: Lint, e2e, visual check**

Run: `npm run lint` — expected clean.
Run: `npm run test:e2e` — expected all pass.
Then render-and-look (dataviz step 7): with the stack up (`docker compose up -d`), use Playwright CLI to screenshot `http://localhost:3005/` in both themes and eyeball for label collisions/overflow:

```bash
npx playwright screenshot http://localhost:3005/ overview-dark.png
```

Expected: tiles + chart render; no text overlap at the right edge (end labels have 58px reserved).

- [ ] **Step 6: Commit**

```bash
git add frontend/src/components/activity-chart.tsx frontend/src/app/globals.css frontend/src/app/overview-client.tsx frontend/e2e/overview.spec.ts
git commit -m "feat(overview): 30-day opened vs closed activity chart"
```

---

### Task 8: Issues table core at `/plan` — URL state, sorting, pagination

**Files:**
- Create: `frontend/src/app/plan/plan-client.tsx`
- Modify: `frontend/src/app/plan/page.tsx`
- Test: `frontend/e2e/issues-table.spec.ts` (create)

**Interfaces:**
- Consumes: `GET /api/backend/issues?...` (Task 4 `IssuePage` shape); `getJson` from `../../lib/api`; `relativeTime` from `../../lib/time`.
- Produces: `PlanClient` component; URL params `repo_id, state, label, assignee, q, sort, order, offset` on `/plan` (the saved-views foundation). Exports `TableParams` type + `COLUMNS` const consumed by Task 9's `Toolbar`. The h1 stays exactly `Plan` (shell.spec.ts depends on it).

- [ ] **Step 1: Write the plan client**

Create `frontend/src/app/plan/plan-client.tsx`:

```tsx
"use client";

import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useState } from "react";
import { getJson } from "../../lib/api";
import { relativeTime } from "../../lib/time";

export type IssueRow = {
  id: number;
  repository_id: number;
  repo_full_name: string;
  number: number;
  title: string;
  state: "open" | "closed";
  author_login: string;
  labels: { name: string; color: string }[];
  assignees: string[];
  milestone_title: string | null;
  comments_count: number;
  gh_created_at: string;
  gh_updated_at: string;
  gh_closed_at: string | null;
};

export type IssuePage = {
  items: IssueRow[];
  total: number;
  limit: number;
  offset: number;
};

export type SortKey = "updated" | "created" | "comments" | "number" | "title";

export type ColumnKey =
  | "repo"
  | "number"
  | "title"
  | "labels"
  | "assignees"
  | "comments"
  | "updated"
  | "state"
  | "milestone"
  | "author"
  | "created";

export type TableParams = {
  repoId: string | null;
  state: string;
  label: string | null;
  assignee: string | null;
  q: string | null;
  setParams: (updates: Record<string, string | null>) => void;
};

export const COLUMNS: {
  key: ColumnKey;
  label: string;
  sort?: SortKey;
  defaultVisible: boolean;
}[] = [
  { key: "repo", label: "Repo", defaultVisible: true },
  { key: "number", label: "#", sort: "number", defaultVisible: true },
  { key: "title", label: "Title", sort: "title", defaultVisible: true },
  { key: "labels", label: "Labels", defaultVisible: true },
  { key: "assignees", label: "Assignees", defaultVisible: true },
  { key: "comments", label: "Comments", sort: "comments", defaultVisible: true },
  { key: "updated", label: "Updated", sort: "updated", defaultVisible: true },
  { key: "state", label: "State", defaultVisible: true },
  { key: "milestone", label: "Milestone", defaultVisible: false },
  { key: "author", label: "Author", defaultVisible: false },
  { key: "created", label: "Created", sort: "created", defaultVisible: false },
];

const LIMIT = 50;

const card =
  "rounded-[14px] border border-(--color-border) bg-(--color-surface) shadow-(--shadow-card)";
const btn =
  "rounded-lg border border-(--color-border) bg-(--color-surface) px-2.5 py-1.5 text-(--color-primary) transition-all duration-150 hover:bg-(--accent-tint) disabled:text-(--color-text-muted) disabled:hover:bg-(--color-surface)";

function stateBadge(state: IssueRow["state"]) {
  return state === "open"
    ? "text-(--color-primary) border-(--color-primary)"
    : "text-(--color-text-muted) border-(--color-border)";
}

export function PlanClient() {
  const searchParams = useSearchParams();
  const router = useRouter();

  const setParams = useCallback(
    (updates: Record<string, string | null>) => {
      const next = new URLSearchParams(searchParams.toString());
      for (const [key, value] of Object.entries(updates)) {
        if (value === null || value === "") next.delete(key);
        else next.set(key, value);
      }
      const qs = next.toString();
      router.replace(qs ? `/plan?${qs}` : "/plan", { scroll: false });
    },
    [router, searchParams],
  );

  const repoId = searchParams.get("repo_id");
  const state = searchParams.get("state") ?? "open";
  const label = searchParams.get("label");
  const assignee = searchParams.get("assignee");
  const q = searchParams.get("q");
  const sort = (searchParams.get("sort") ?? "updated") as SortKey;
  const order = searchParams.get("order") ?? "desc";
  const offset = Math.max(0, Number(searchParams.get("offset") ?? "0") || 0);

  const backendQuery = new URLSearchParams({
    state,
    sort,
    order,
    limit: String(LIMIT),
    offset: String(offset),
  });
  if (repoId) backendQuery.set("repo_id", repoId);
  if (label) backendQuery.set("label", label);
  if (assignee) backendQuery.set("assignee", assignee);
  if (q) backendQuery.set("q", q);

  const { data, error, isPending } = useQuery({
    queryKey: ["issues", backendQuery.toString()],
    queryFn: () => getJson<IssuePage>(`/api/backend/issues?${backendQuery}`),
    placeholderData: keepPreviousData,
  });

  // Task 9 adds the setter + toolbar; destructuring only `visible` keeps lint clean here
  const [visible] = useState<Set<ColumnKey>>(
    () => new Set(COLUMNS.filter((c) => c.defaultVisible).map((c) => c.key)),
  );

  const toggleSort = (key: SortKey) => {
    if (sort === key) {
      setParams({ order: order === "desc" ? "asc" : "desc", offset: null });
    } else {
      setParams({ sort: key, order: "desc", offset: null });
    }
  };

  const shownColumns = COLUMNS.filter((c) => visible.has(c.key));

  return (
    <div className="flex flex-col gap-4" data-testid="plan-content">
      <div className="flex items-baseline gap-3">
        <h1 className="text-lg font-semibold tracking-[-0.01em]">Plan</h1>
        <span className="text-(--color-text-muted)">
          Issues across your synced repositories
        </span>
      </div>

      {/* Toolbar mounts here in the next task */}

      {isPending ? (
        <div className={`${card} px-6 py-16 text-center text-(--color-text-muted)`}>
          Loading issues…
        </div>
      ) : error ? (
        <div className={`${card} px-6 py-16 text-center`}>
          <div className="text-sm font-medium">Backend unavailable</div>
          <div className="pt-1.5 text-(--color-text-muted)">{error.message}</div>
        </div>
      ) : !data || data.total === 0 ? (
        <div className={`${card} flex flex-col items-center gap-1.5 px-6 py-16 text-center`}>
          <div className="text-sm font-medium">No issues match these filters</div>
          <div className="max-w-md text-(--color-text-muted)">
            Adjust the filters above, or clear them to see every open issue.
          </div>
          <button
            type="button"
            className={`${btn} mt-2`}
            onClick={() => router.replace("/plan")}
          >
            Clear filters
          </button>
        </div>
      ) : (
        <>
          <div className={`${card} overflow-x-auto`}>
            <table className="w-full text-left">
              <thead>
                <tr className="border-b border-(--color-border)">
                  {shownColumns.map((col) => (
                    <th key={col.key} className="px-3 py-2 font-medium">
                      {col.sort ? (
                        <button
                          type="button"
                          onClick={() => toggleSort(col.sort!)}
                          className={`flex items-center gap-1 transition-all duration-150 hover:text-(--color-primary) ${
                            sort === col.sort
                              ? "text-(--color-primary)"
                              : "text-(--color-text)"
                          }`}
                        >
                          {col.label}
                          <span
                            aria-hidden
                            className={
                              sort === col.sort ? "" : "text-(--color-text-muted)"
                            }
                          >
                            {sort === col.sort && order === "asc" ? "▲" : "▼"}
                          </span>
                        </button>
                      ) : (
                        col.label
                      )}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {data.items.map((row) => (
                  <tr
                    key={row.id}
                    className="border-b border-(--color-border) last:border-b-0"
                  >
                    {visible.has("repo") ? (
                      <td className="px-3 py-2 whitespace-nowrap text-(--color-text-muted)">
                        {row.repo_full_name.split("/")[1]}
                      </td>
                    ) : null}
                    {visible.has("number") ? (
                      <td className="px-3 py-2 text-(--color-text-muted)">
                        #{row.number}
                      </td>
                    ) : null}
                    {visible.has("title") ? (
                      <td className="max-w-md px-3 py-2">
                        <a
                          href={`https://github.com/${row.repo_full_name}/issues/${row.number}`}
                          target="_blank"
                          rel="noreferrer"
                          className="block truncate font-medium hover:text-(--color-primary)"
                          title={row.title}
                        >
                          {row.title}
                        </a>
                      </td>
                    ) : null}
                    {visible.has("labels") ? (
                      <td className="px-3 py-2">
                        <span className="flex flex-wrap gap-1">
                          {row.labels.slice(0, 3).map((lb) => (
                            <span
                              key={lb.name}
                              className="flex items-center gap-1 rounded-full border border-(--color-border) px-1.5 text-[10px]"
                            >
                              <span
                                className="inline-block h-1.5 w-1.5 rounded-full"
                                style={{ background: `#${lb.color || "8888"}` }}
                              />
                              {lb.name}
                            </span>
                          ))}
                          {row.labels.length > 3 ? (
                            <span className="text-[10px] text-(--color-text-muted)">
                              +{row.labels.length - 3}
                            </span>
                          ) : null}
                        </span>
                      </td>
                    ) : null}
                    {visible.has("assignees") ? (
                      <td className="px-3 py-2 whitespace-nowrap text-(--color-text-muted)">
                        {row.assignees.join(", ") || "—"}
                      </td>
                    ) : null}
                    {visible.has("comments") ? (
                      <td className="px-3 py-2 text-(--color-text-muted)">
                        {row.comments_count}
                      </td>
                    ) : null}
                    {visible.has("updated") ? (
                      <td className="px-3 py-2 whitespace-nowrap text-(--color-text-muted)">
                        {relativeTime(row.gh_updated_at)}
                      </td>
                    ) : null}
                    {visible.has("state") ? (
                      <td className="px-3 py-2">
                        <span
                          className={`rounded-full border px-1.5 text-[10px] ${stateBadge(row.state)}`}
                        >
                          {row.state}
                        </span>
                      </td>
                    ) : null}
                    {visible.has("milestone") ? (
                      <td className="px-3 py-2 whitespace-nowrap text-(--color-text-muted)">
                        {row.milestone_title ?? "—"}
                      </td>
                    ) : null}
                    {visible.has("author") ? (
                      <td className="px-3 py-2 whitespace-nowrap text-(--color-text-muted)">
                        {row.author_login}
                      </td>
                    ) : null}
                    {visible.has("created") ? (
                      <td className="px-3 py-2 whitespace-nowrap text-(--color-text-muted)">
                        {relativeTime(row.gh_created_at)}
                      </td>
                    ) : null}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="flex items-center gap-3">
            <span className="text-(--color-text-muted)">
              {data.offset + 1}–{Math.min(data.offset + data.limit, data.total)} of{" "}
              {data.total}
            </span>
            <div className="grow" />
            <button
              type="button"
              className={btn}
              disabled={data.offset === 0}
              onClick={() =>
                setParams({ offset: String(Math.max(0, data.offset - LIMIT)) })
              }
            >
              ← Prev
            </button>
            <button
              type="button"
              className={btn}
              disabled={data.offset + data.limit >= data.total}
              onClick={() => setParams({ offset: String(data.offset + LIMIT) })}
            >
              Next →
            </button>
          </div>
        </>
      )}
    </div>
  );
}
```

Note for the reviewer: `TableParams` and `COLUMNS` are exported for Task 9's toolbar; exports don't trip unused-var lint. The `useState` deliberately destructures only `visible` — Task 9 changes it to `const [visible, setVisible] = useState<Set<ColumnKey>>(...)` when the toolbar needs the setter.

- [ ] **Step 2: Replace the placeholder page**

Replace the full contents of `frontend/src/app/plan/page.tsx` with (`useSearchParams` requires a Suspense boundary at prerender):

```tsx
import { Suspense } from "react";
import { PlanClient } from "./plan-client";

export default function PlanPage() {
  return (
    <Suspense fallback={null}>
      <PlanClient />
    </Suspense>
  );
}
```

- [ ] **Step 3: Write the e2e spec**

Create `frontend/e2e/issues-table.spec.ts`:

```ts
import { expect, test } from "@playwright/test";

const row = (over: Partial<Record<string, unknown>>) => ({
  id: 1,
  repository_id: 500,
  repo_full_name: "patelmj/mehova",
  number: 42,
  title: "Fix token refresh",
  state: "open",
  author_login: "patelmj",
  labels: [{ name: "bug", color: "d73a4a" }],
  assignees: ["patelmj"],
  milestone_title: null,
  comments_count: 3,
  gh_created_at: "2026-07-01T00:00:00Z",
  gh_updated_at: "2026-07-17T10:00:00Z",
  gh_closed_at: null,
  ...over,
});

const page1 = {
  items: [
    row({}),
    row({ id: 2, number: 43, title: "Redis rate limiting", comments_count: 9 }),
  ],
  total: 2,
  limit: 50,
  offset: 0,
};

test("issues table renders rows and sorts server-side", async ({ page }) => {
  const requested: string[] = [];
  await page.route(/\/api\/backend\/issues\?/, (route) => {
    requested.push(route.request().url());
    return route.fulfill({ json: page1 });
  });
  await page.goto("/plan");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Plan");
  await expect(page.getByText("Fix token refresh")).toBeVisible();
  await expect(page.getByText("Redis rate limiting")).toBeVisible();
  await expect(page.getByText("1–2 of 2")).toBeVisible();

  await page.getByRole("button", { name: /comments/i }).click();
  await expect(page).toHaveURL(/sort=comments/);
  await expect
    .poll(() => requested.some((u) => u.includes("sort=comments")))
    .toBe(true);
});

test("empty result shows clear-filters state", async ({ page }) => {
  await page.route(/\/api\/backend\/issues\?/, (route) =>
    route.fulfill({ json: { items: [], total: 0, limit: 50, offset: 0 } }),
  );
  await page.goto("/plan?q=zzz");
  await expect(page.getByText("No issues match these filters")).toBeVisible();
  await page.getByRole("button", { name: "Clear filters" }).click();
  await expect(page).toHaveURL(/\/plan$/);
});
```

- [ ] **Step 4: Lint and run e2e**

Run: `npm run lint` — expected clean (see the Step 1 note if `setVisible` is flagged).
Run: `npm run test:e2e` — expected all pass. `shell.spec.ts` "all sidebar routes navigate" still passes: h1 is `Plan` and renders unconditionally.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/app/plan/plan-client.tsx frontend/src/app/plan/page.tsx frontend/e2e/issues-table.spec.ts
git commit -m "feat(plan): spreadsheet issues table - URL state, server-side sort and pagination"
```

---

### Task 9: Issues table toolbar — repo/state/search/facet filters + column visibility

**Files:**
- Create: `frontend/src/app/plan/toolbar.tsx`
- Modify: `frontend/src/app/plan/plan-client.tsx`
- Test: `frontend/e2e/issues-table.spec.ts`

**Interfaces:**
- Consumes: `GET /api/backend/issues/facets` (Task 5 `FacetsOut`), `GET /api/backend/repositories` (existing), `TableParams`/`COLUMNS`/`ColumnKey` from `./plan-client`, `getJson` from `../../lib/api`.
- Produces: `<Toolbar params={TableParams} visible={Set<ColumnKey>} onToggleColumn={(key) => void} />`; a "no repositories connected" empty state on `/plan`.

- [ ] **Step 1: Write the toolbar**

Create `frontend/src/app/plan/toolbar.tsx`:

```tsx
"use client";

import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { getJson } from "../../lib/api";
import { COLUMNS, type ColumnKey, type TableParams } from "./plan-client";

type Facets = { labels: { name: string; color: string }[]; assignees: string[] };
type Repo = { id: number; full_name: string };

const control =
  "rounded-lg border border-(--color-border) bg-(--color-surface) px-2 py-1.5 transition-all duration-150";

const STATES = [
  { value: "open", label: "Open" },
  { value: "closed", label: "Closed" },
  { value: "all", label: "All" },
];

export function Toolbar({
  params,
  visible,
  onToggleColumn,
}: {
  params: TableParams;
  visible: Set<ColumnKey>;
  onToggleColumn: (key: ColumnKey) => void;
}) {
  const { repoId, state, label, assignee, q, setParams } = params;

  const { data: repos } = useQuery({
    queryKey: ["repositories"],
    queryFn: () => getJson<Repo[]>("/api/backend/repositories"),
  });
  const { data: facets } = useQuery({
    queryKey: ["issue-facets", repoId],
    queryFn: () =>
      getJson<Facets>(
        `/api/backend/issues/facets${repoId ? `?repo_id=${repoId}` : ""}`,
      ),
  });

  const [searchText, setSearchText] = useState(q ?? "");
  useEffect(() => {
    setSearchText(q ?? "");
  }, [q]);
  useEffect(() => {
    const timer = setTimeout(() => {
      if ((q ?? "") !== searchText) {
        setParams({ q: searchText || null, offset: null });
      }
    }, 300);
    return () => clearTimeout(timer);
  }, [searchText, q, setParams]);

  return (
    <div className="flex flex-wrap items-center gap-2">
      <select
        aria-label="Repository"
        className={control}
        value={repoId ?? ""}
        onChange={(e) =>
          setParams({
            repo_id: e.target.value || null,
            label: null,
            assignee: null,
            offset: null,
          })
        }
      >
        <option value="">All repositories</option>
        {(repos ?? []).map((repo) => (
          <option key={repo.id} value={String(repo.id)}>
            {repo.full_name}
          </option>
        ))}
      </select>

      <div className="flex rounded-[9px] border border-(--color-border) bg-(--color-surface) p-0.5">
        {STATES.map(({ value, label: stateLabel }) => (
          <button
            key={value}
            type="button"
            onClick={() => setParams({ state: value === "open" ? null : value, offset: null })}
            className={`rounded-[7px] px-2.5 py-1 transition-all duration-150 ${
              state === value
                ? "bg-(--accent-tint) font-medium text-(--color-primary)"
                : "text-(--color-text-muted) hover:text-(--color-text)"
            }`}
          >
            {stateLabel}
          </button>
        ))}
      </div>

      <input
        type="search"
        aria-label="Search issues"
        placeholder="Search title or #number"
        className={`${control} w-52`}
        value={searchText}
        onChange={(e) => setSearchText(e.target.value)}
      />

      <select
        aria-label="Label"
        className={control}
        value={label ?? ""}
        onChange={(e) => setParams({ label: e.target.value || null, offset: null })}
      >
        <option value="">Any label</option>
        {(facets?.labels ?? []).map((lb) => (
          <option key={lb.name} value={lb.name}>
            {lb.name}
          </option>
        ))}
      </select>

      <select
        aria-label="Assignee"
        className={control}
        value={assignee ?? ""}
        onChange={(e) =>
          setParams({ assignee: e.target.value || null, offset: null })
        }
      >
        <option value="">Any assignee</option>
        {(facets?.assignees ?? []).map((login) => (
          <option key={login} value={login}>
            {login}
          </option>
        ))}
      </select>

      <div className="grow" />

      <details className="relative">
        <summary
          className={`${control} cursor-pointer list-none text-(--color-text-muted) hover:text-(--color-text)`}
        >
          Columns
        </summary>
        <div className="absolute right-0 z-10 mt-1 flex w-44 flex-col gap-1 rounded-lg border border-(--color-border) bg-(--color-surface) p-2 shadow-(--shadow-card)">
          {COLUMNS.map((col) => (
            <label key={col.key} className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={visible.has(col.key)}
                onChange={() => onToggleColumn(col.key)}
              />
              {col.label === "#" ? "Number" : col.label}
            </label>
          ))}
        </div>
      </details>
    </div>
  );
}
```

- [ ] **Step 2: Wire the toolbar into plan-client**

In `frontend/src/app/plan/plan-client.tsx`:

1. Add the import:

```tsx
import { Toolbar } from "./toolbar";
```

2. Also fetch repositories (for the no-repos empty state) — add below the issues `useQuery`:

```tsx
  const { data: repos } = useQuery({
    queryKey: ["repositories"],
    queryFn: () => getJson<{ id: number; full_name: string }[]>("/api/backend/repositories"),
  });
```

3. Restore the state setter — change the `useState` line to:

```tsx
  const [visible, setVisible] = useState<Set<ColumnKey>>(
    () => new Set(COLUMNS.filter((c) => c.defaultVisible).map((c) => c.key)),
  );
```

then add a column toggle handler below it:

```tsx
  const onToggleColumn = (key: ColumnKey) => {
    setVisible((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };
```

4. Replace the `{/* Toolbar mounts here in the next task */}` comment with:

```tsx
      <Toolbar
        params={{ repoId, state, label, assignee, q, setParams }}
        visible={visible}
        onToggleColumn={onToggleColumn}
      />
```

5. Change the empty-state branch condition so a connected-but-empty workspace and a never-connected workspace read differently. Replace `: !data || data.total === 0 ? (` and the empty-state card with:

```tsx
      ) : repos && repos.length === 0 ? (
        <div className={`${card} flex flex-col items-center gap-1.5 px-6 py-16 text-center`}>
          <div className="text-sm font-medium">No repositories connected</div>
          <div className="max-w-md text-(--color-text-muted)">
            Install the IssueLens GitHub App and sync a repository to fill this
            table with real issues.
          </div>
          <Link
            className="pt-2 text-(--color-primary) hover:underline"
            href="/repositories"
          >
            Go to Repositories →
          </Link>
        </div>
      ) : !data || data.total === 0 ? (
```

(keep the existing "No issues match these filters" card as the following branch), and add the Link import at the top:

```tsx
import Link from "next/link";
```

- [ ] **Step 3: Extend the e2e spec**

Add to `frontend/e2e/issues-table.spec.ts`:

```ts
const facets = {
  labels: [
    { name: "bug", color: "d73a4a" },
    { name: "feature", color: "a2eeef" },
  ],
  assignees: ["patelmj"],
};

const repos = [
  { id: 500, full_name: "patelmj/mehova" },
  { id: 501, full_name: "patelmj/IssueLens" },
];

test("toolbar filters round-trip to the API and the URL", async ({ page }) => {
  const requested: string[] = [];
  await page.route(/\/api\/backend\/issues\/facets/, (route) =>
    route.fulfill({ json: facets }),
  );
  await page.route(/\/api\/backend\/repositories$/, (route) =>
    route.fulfill({ json: repos }),
  );
  await page.route(/\/api\/backend\/issues\?/, (route) => {
    requested.push(route.request().url());
    return route.fulfill({ json: page1 });
  });
  await page.goto("/plan");
  await expect(page.getByText("Fix token refresh")).toBeVisible();

  await page.getByRole("button", { name: "Closed" }).click();
  await expect(page).toHaveURL(/state=closed/);
  await expect
    .poll(() => requested.some((u) => u.includes("state=closed")))
    .toBe(true);

  await page.getByLabel("Label").selectOption("bug");
  await expect(page).toHaveURL(/label=bug/);

  await page.getByLabel("Search issues").fill("token");
  await expect(page).toHaveURL(/q=token/, { timeout: 2_000 });

  await page.getByText("Columns").click();
  await page.getByLabel("Milestone").check();
  await expect(
    page.getByRole("columnheader", { name: "Milestone" }),
  ).toBeVisible();
});

test("no connected repositories shows connect empty state", async ({ page }) => {
  await page.route(/\/api\/backend\/issues\/facets/, (route) =>
    route.fulfill({ json: { labels: [], assignees: [] } }),
  );
  await page.route(/\/api\/backend\/repositories$/, (route) =>
    route.fulfill({ json: [] }),
  );
  await page.route(/\/api\/backend\/issues\?/, (route) =>
    route.fulfill({ json: { items: [], total: 0, limit: 50, offset: 0 } }),
  );
  await page.goto("/plan");
  await expect(page.getByText("No repositories connected")).toBeVisible();
});
```

- [ ] **Step 4: Lint, full e2e, live check**

Run: `npm run lint` — expected clean.
Run: `npm run test:e2e` — expected all specs pass.
Live verification against real data (backend up via `docker compose up -d`): open `http://localhost:3005/plan` with Playwright CLI and confirm real issues render, a label filter narrows rows, and the URL carries the params:

```bash
npx playwright screenshot "http://localhost:3005/plan?state=all" plan-table.png
```

Expected: table shows real synced issues from both repos.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/app/plan/toolbar.tsx frontend/src/app/plan/plan-client.tsx frontend/e2e/issues-table.spec.ts
git commit -m "feat(plan): toolbar - repo/state/search/label/assignee filters and column visibility"
```

---

## Post-task verification (before the merge conversation)

1. Backend: `uv run pytest -q` and `uv run ruff check .` — everything green.
2. Frontend: `npm run lint` and `npm run test:e2e` — everything green.
3. Live: `docker compose up -d`, open `http://localhost:3005/` — Overview shows real numbers (2 repos, ~94 open issues) and the chart; `/plan` lists real issues; filters and sorting round-trip.
4. Fable-tier final whole-branch review (house rule), one fix wave, re-review.
5. Pause and ask the user before any PR/merge action.

## Spec-coverage map

| Spec section | Task |
|---|---|
| §2.1 `GET /stats/overview` | 3 |
| §2.2 `GET /issues` + facets | 4, 5 |
| §2.3 migration 0003 indexes | 1 |
| §2.4 `_job_id` dedup | 2 |
| §3 Overview page (tiles, strip, empty state) | 6 |
| §3 activity chart | 7 |
| §4 issues table (columns, sort, URL state, pager) | 8 |
| §4 toolbar (repo/state/search/label/assignee/columns) | 9 |
| §5 error handling / empty states | 6, 8, 9 |
| §6 backend tests | 1–5 |
| §6 intake tests (503, since, e2e empty state) | 2, 6 |
| §6 e2e | 6, 7, 8, 9 |
| §8 intake checklist | 1, 2, 3 (stale copy dies in 6) |
