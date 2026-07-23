# Repo Visibility Toggles (#55) + Issue Detail Drawer (#52) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Repos can be hidden from every select and aggregate via a toggle on /repositories, and clicking an execution-queue row (or matrix bubble) opens a reusable issue-detail drawer in the right rail.

**Architecture:** Backend adds a `visible` flag on `repositories` (presentation-only — hidden repos keep syncing), filters it server-side in the default repo list and every unscoped aggregate query, and adds one aggregate `GET /issues/{issue_id}` endpoint. Frontend adds a toggle to the /repositories page and a self-fetching `IssueDetailPanel` component that the matrix right rail swaps in for the execution queue.

**Tech Stack:** FastAPI + SQLAlchemy 2.0 async + Alembic (hand-written migrations), Next.js 16 App Router client components, TanStack React Query v5, Tailwind v4 design tokens, react-markdown + remark-gfm (new deps, approved), Playwright e2e.

**Spec:** `docs/superpowers/specs/2026-07-22-repo-visibility-issue-detail-drawer-design.md`

## Global Constraints

- Work on branch `feat/repo-visibility-issue-detail` (created in Task 1, from `main`).
- Commit messages must NOT include author attribution, model identifiers, or Co-Authored-By lines.
- Tailwind v4 CSS-variable classes use PARENTHESES: `bg-(--color-surface)`, never `bg-[--color-surface]`.
- Never hide UI elements when inactive — mute them (change color/fill only, keep shape and presence).
- This is a modified Next.js (see `frontend/AGENTS.md`) — if any Next.js API behaves unexpectedly, read the relevant guide in `frontend/node_modules/next/dist/docs/` before improvising. All frontend work here is client-component edits inside existing routes; no new routes.
- Backend lint: `python -m ruff check app tests` (line-length 100). Frontend lint: `npm run lint`.
- Backend tests require local Postgres (the dev docker-compose one) on localhost:5432; conftest creates/migrates `issuelens_test` automatically.
- Handle errors explicitly — every new mutation/query renders its error state.
- The only new npm dependencies allowed are `react-markdown` and `remark-gfm` (user-approved). No other new deps, front or back.

---

### Task 1: Backend — `visible` column, migration, repositories API

**Files:**
- Create: `backend/alembic/versions/0012_repository_visible.py`
- Modify: `backend/app/models.py` (Repository, ~line 53)
- Modify: `backend/app/routers/repositories.py`
- Test: `backend/tests/test_api_repositories.py`

**Interfaces:**
- Consumes: existing `Repository` model, `RepositoryOut`, `_list_repos`.
- Produces: `Repository.visible: Mapped[bool]`; `RepositoryOut.visible: bool`; `GET /repositories?include_hidden=<bool>` (default `false` → visible only); `PATCH /repositories/{repo_id}` body `{"visible": bool}` → `RepositoryOut`, 404 unknown; `POST /repositories/refresh` now returns ALL repos (hidden included). Tasks 2–6 rely on exactly these.

- [ ] **Step 1: Create the branch**

```bash
git checkout main && git pull && git checkout -b feat/repo-visibility-issue-detail
```

- [ ] **Step 2: Write the failing tests** — append to `backend/tests/test_api_repositories.py`. Also modify the existing `seed_repo` helper to accept parameters (existing callers pass no args and keep working):

Replace the existing `seed_repo` (lines 17–24) with:

```python
async def seed_repo(
    repo_id: int = 500,
    full_name: str = "patelmj/IssueLens",
    visible: bool = True,
) -> None:
    async with get_sessionmaker()() as session:
        await session.merge(Installation(id=42, account_login="patelmj"))
        await session.merge(
            Repository(
                id=repo_id, installation_id=42, full_name=full_name,
                owner="patelmj", name=full_name.split("/")[1], visible=visible,
            )
        )
        await session.commit()
```

Append at the end of the file:

```python
async def test_list_excludes_hidden_by_default(clean_db, api):
    await seed_repo()
    await seed_repo(repo_id=501, full_name="patelmj/hidden-repo", visible=False)
    async with api as client:
        resp = await client.get("/repositories")
    body = resp.json()
    assert [r["full_name"] for r in body] == ["patelmj/IssueLens"]
    assert body[0]["visible"] is True


async def test_list_include_hidden_returns_all(clean_db, api):
    await seed_repo()
    await seed_repo(repo_id=501, full_name="patelmj/hidden-repo", visible=False)
    async with api as client:
        resp = await client.get("/repositories?include_hidden=true")
    body = resp.json()
    assert [(r["full_name"], r["visible"]) for r in body] == [
        ("patelmj/IssueLens", True),
        ("patelmj/hidden-repo", False),
    ]


async def test_patch_visibility_toggles(clean_db, api):
    await seed_repo()
    async with api as client:
        resp = await client.patch("/repositories/500", json={"visible": False})
        assert resp.status_code == 200
        assert resp.json()["visible"] is False
        listed = await client.get("/repositories")
        assert listed.json() == []
        back = await client.patch("/repositories/500", json={"visible": True})
        assert back.json()["visible"] is True


async def test_patch_visibility_unknown_repo_404(clean_db, api):
    async with api as client:
        resp = await client.patch("/repositories/99999", json={"visible": False})
    assert resp.status_code == 404
```

- [ ] **Step 3: Run the new tests to verify they fail**

Run: `cd backend && python -m pytest tests/test_api_repositories.py -q`
Expected: FAIL — `visible` is an invalid keyword for `Repository`, and the PATCH tests 405/404.

- [ ] **Step 4: Write the migration** — create `backend/alembic/versions/0012_repository_visible.py`:

```python
"""repository visible flag"""

import sqlalchemy as sa
from alembic import op

revision = "0012"
down_revision = "0011"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "repositories",
        sa.Column(
            "visible", sa.Boolean(), nullable=False, server_default=sa.text("true")
        ),
    )


def downgrade() -> None:
    op.drop_column("repositories", "visible")
```

- [ ] **Step 5: Add the model column** — in `backend/app/models.py`, add to `Repository` after `open_issues_count` (line 53):

```python
    visible: Mapped[bool] = mapped_column(
        Boolean, default=True, server_default=text("true")
    )
```

(`Boolean` and `text` are already imported.)

- [ ] **Step 6: Update the repositories router** — in `backend/app/routers/repositories.py`:

Add `visible: bool` to `RepositoryOut` (after `sync_error`):

```python
class RepositoryOut(BaseModel):
    id: int
    full_name: str
    private: bool
    open_issues_count: int
    last_synced_at: datetime | None
    sync_status: str
    sync_error: str | None
    visible: bool

    model_config = {"from_attributes": True}
```

Replace `_list_repos` and `list_repositories`, and make `refresh_repositories` return all repos:

```python
async def _list_repos(
    session: AsyncSession, include_hidden: bool = False
) -> list[Repository]:
    query = select(Repository).order_by(Repository.full_name)
    if not include_hidden:
        query = query.where(Repository.visible.is_(True))
    result = await session.execute(query)
    return list(result.scalars())


@router.get("", response_model=list[RepositoryOut])
async def list_repositories(
    include_hidden: bool = False,
    session: AsyncSession = Depends(get_session),
) -> list[Repository]:
    return await _list_repos(session, include_hidden=include_hidden)
```

In `refresh_repositories`, change the final line to:

```python
    return await _list_repos(session, include_hidden=True)
```

Add the PATCH endpoint after `refresh_repositories`:

```python
class RepositoryVisibilityPatch(BaseModel):
    visible: bool


@router.patch("/{repo_id}", response_model=RepositoryOut)
async def update_repository(
    repo_id: int,
    patch: RepositoryVisibilityPatch,
    session: AsyncSession = Depends(get_session),
) -> Repository:
    repo = (
        await session.execute(select(Repository).where(Repository.id == repo_id))
    ).scalar_one_or_none()
    if repo is None:
        raise HTTPException(status_code=404, detail="Repository not found")
    repo.visible = patch.visible
    await session.commit()
    await session.refresh(repo)
    return repo
```

- [ ] **Step 7: Run the full repositories test file**

Run: `cd backend && python -m pytest tests/test_api_repositories.py -q`
Expected: PASS (all tests, old and new — conftest migrates the test DB to head automatically).

- [ ] **Step 8: Upgrade the dev database and lint**

Run: `cd backend && python -m alembic upgrade head && python -m ruff check app tests`
Expected: `Running upgrade 0011 -> 0012` (or already at head), ruff clean.

- [ ] **Step 9: Commit**

```bash
git add backend/alembic/versions/0012_repository_visible.py backend/app/models.py backend/app/routers/repositories.py backend/tests/test_api_repositories.py
git commit -m "feat: repository visible flag with include_hidden list + PATCH toggle (#55)"
```

---

### Task 2: Backend — visibility filtering in aggregate queries

**Files:**
- Modify: `backend/app/routers/stats.py` (overview_stats, lines 37–99)
- Modify: `backend/app/routers/issues.py` (`_filtered_query` lines 64–100, `issue_facets` lines 156–202)
- Modify: `backend/app/triage/service.py` (`_inbox_query` lines 41–60)
- Test: `backend/tests/test_api_stats.py`, `backend/tests/test_api_issues.py`, `backend/tests/test_api_triage.py`

**Interfaces:**
- Consumes: `Repository.visible` from Task 1.
- Produces: rule used by all tasks — queries NOT scoped to an explicit `repo_id` only see visible repos; explicit `repo_id` scoping is never blocked. Adds test helper `hide_repo(repo_id)` in `tests/test_api_issues.py` (imported by the triage tests).

- [ ] **Step 1: Write the failing tests**

Append to `backend/tests/test_api_issues.py`:

```python
async def hide_repo(repo_id: int) -> None:
    async with get_sessionmaker()() as session:
        repo = await session.get(Repository, repo_id)
        repo.visible = False
        await session.commit()


async def test_unscoped_list_excludes_hidden_repos(clean_db, api):
    await seed_issues()
    await hide_repo(501)
    body = await get_body(api, "/issues")
    assert [i["title"] for i in body["items"]] == ["Alpha bug"]
    assert body["total"] == 1


async def test_explicit_repo_id_still_reaches_hidden_repo(clean_db, api):
    await seed_issues()
    await hide_repo(501)
    body = await get_body(api, "/issues?repo_id=501")
    assert [i["title"] for i in body["items"]] == ["Delta task"]


async def test_facets_exclude_hidden_repos(clean_db, api):
    await seed_issues()
    await hide_repo(500)
    body = await get_body(api, "/issues/facets")
    assert [lb["name"] for lb in body["labels"]] == ["bug"]
    assert body["assignees"] == ["octocat"]


async def test_facets_explicit_repo_id_ignores_visibility(clean_db, api):
    await seed_issues()
    await hide_repo(500)
    body = await get_body(api, "/issues/facets?repo_id=500")
    assert [lb["name"] for lb in body["labels"]] == ["bug", "feature"]


async def test_facets_components_exclude_hidden_repos(clean_db, api):
    await seed_issues()
    await seed_classifications()
    await hide_repo(500)
    body = await get_body(api, "/issues/facets")
    assert body["components"] == ["sync"]
```

Append to `backend/tests/test_api_stats.py`:

```python
async def hide_repo(repo_id: int) -> None:
    async with get_sessionmaker()() as session:
        repo = await session.get(Repository, repo_id)
        repo.visible = False
        await session.commit()


async def test_overview_stats_exclude_hidden_repos(clean_db, api):
    await seed_overview_data()
    await hide_repo(500)
    async with api as client:
        resp = await client.get("/stats/overview")
    body = resp.json()
    assert body["connected_repos"] == 1
    assert body["open_issues"] == 0  # both open issues live in hidden repo 500
    assert [r["full_name"] for r in body["top_repos"]] == ["patelmj/IssueLens"]
    assert body["activity"] == []  # opened issue 1 and closed issue 3 are in repo 500
    assert body["last_synced_at"] is not None  # repo 501 still visible
```

In `backend/tests/test_api_triage.py`, extend the existing import from `tests.test_api_issues` to include `hide_repo`:

```python
from tests.test_api_issues import (
    NOW,
    hide_repo,
    seed_classifications,
    seed_issues,
    seed_readiness,
)
```

and append:

```python
async def test_inbox_excludes_hidden_repos(clean_db, api):
    await seed_issues()
    await seed_classifications()
    await seed_readiness()
    await hide_repo(500)
    body = await get_body(api, "/triage/inbox?threshold=100")
    assert [i["title"] for i in body["items"]] == ["Delta task"]
    # explicit repo_id scoping still reaches the hidden repo
    scoped = await get_body(api, "/triage/inbox?threshold=100&repo_id=500")
    assert [i["title"] for i in scoped["items"]] == ["Alpha bug"]
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd backend && python -m pytest tests/test_api_issues.py tests/test_api_stats.py tests/test_api_triage.py -q`
Expected: the six new tests FAIL (hidden repos still appear); all pre-existing tests PASS.

- [ ] **Step 3: Filter stats** — in `backend/app/routers/stats.py`, replace the five queries in `overview_stats`:

```python
    connected_repos = (
        await session.execute(
            select(func.count())
            .select_from(Repository)
            .where(Repository.visible.is_(True))
        )
    ).scalar_one()
    open_issues = (
        await session.execute(
            select(func.count())
            .select_from(Issue)
            .join(Repository, Issue.repository_id == Repository.id)
            .where(
                Issue.state == "open",
                Issue.is_pull_request.is_(False),
                Repository.visible.is_(True),
            )
        )
    ).scalar_one()
    last_synced_at = (
        await session.execute(
            select(func.max(Repository.last_synced_at)).where(
                Repository.visible.is_(True)
            )
        )
    ).scalar_one()
    top_rows = (
        await session.execute(
            select(Repository.id, Repository.full_name, Repository.open_issues_count)
            .where(Repository.visible.is_(True))
            .order_by(Repository.open_issues_count.desc(), Repository.full_name)
            .limit(TOP_REPOS_LIMIT)
        )
    ).all()
```

and add the join + filter to both activity queries:

```python
    opened_rows = (
        await session.execute(
            select(cast(func.timezone("UTC", Issue.gh_created_at), Date).label("day"), func.count())
            .select_from(Issue)
            .join(Repository, Issue.repository_id == Repository.id)
            .where(
                Issue.is_pull_request.is_(False),
                Issue.gh_created_at >= window_start,
                Repository.visible.is_(True),
            )
            .group_by("day")
        )
    ).all()
    closed_rows = (
        await session.execute(
            select(cast(func.timezone("UTC", Issue.gh_closed_at), Date).label("day"), func.count())
            .select_from(Issue)
            .join(Repository, Issue.repository_id == Repository.id)
            .where(
                Issue.is_pull_request.is_(False),
                Issue.gh_closed_at.is_not(None),
                Issue.gh_closed_at >= window_start,
                Repository.visible.is_(True),
            )
            .group_by("day")
        )
    ).all()
```

- [ ] **Step 4: Filter the issues list** — in `backend/app/routers/issues.py::_filtered_query`, replace:

```python
    if repo_id is not None:
        query = query.where(Issue.repository_id == repo_id)
```

with:

```python
    if repo_id is not None:
        query = query.where(Issue.repository_id == repo_id)
    else:
        query = query.where(Repository.visible.is_(True))
```

- [ ] **Step 5: Filter facets** — in `issue_facets`, replace the clause setup with:

```python
    repo_clause = "AND repository_id = :repo_id" if repo_id is not None else ""
    visible_clause = (
        ""
        if repo_id is not None
        else (
            "AND EXISTS (SELECT 1 FROM repositories r "
            "WHERE r.id = issues.repository_id AND r.visible)"
        )
    )
```

and add `{visible_clause}` to both raw-SQL queries:

```python
                f"WHERE NOT is_pull_request {repo_clause} {visible_clause} "
```

(same edit in the labels query and the assignees query). Then filter the components query:

```python
    if repo_id is not None:
        comp_query = comp_query.where(Issue.repository_id == repo_id)
    else:
        comp_query = comp_query.join(
            Repository, Repository.id == Issue.repository_id
        ).where(Repository.visible.is_(True))
```

- [ ] **Step 6: Filter the triage inbox** — in `backend/app/triage/service.py::_inbox_query`, replace:

```python
    if repo_id is not None:
        query = query.where(Issue.repository_id == repo_id)
```

with:

```python
    if repo_id is not None:
        query = query.where(Issue.repository_id == repo_id)
    else:
        query = query.where(Repository.visible.is_(True))
```

- [ ] **Step 7: Run the three test files**

Run: `cd backend && python -m pytest tests/test_api_issues.py tests/test_api_stats.py tests/test_api_triage.py -q`
Expected: PASS (all, including pre-existing).

- [ ] **Step 8: Full backend suite + lint**

Run: `cd backend && python -m pytest -q && python -m ruff check app tests`
Expected: PASS, ruff clean.

- [ ] **Step 9: Commit**

```bash
git add backend/app/routers/stats.py backend/app/routers/issues.py backend/app/triage/service.py backend/tests/test_api_stats.py backend/tests/test_api_issues.py backend/tests/test_api_triage.py
git commit -m "feat: unscoped aggregate queries exclude hidden repositories (#55)"
```

---

### Task 3: Backend — `GET /issues/{issue_id}` detail endpoint

**Files:**
- Modify: `backend/app/routers/issues.py` (add schemas + endpoint at END of file, after `issue_readiness`)
- Test: `backend/tests/test_api_issues.py`

**Interfaces:**
- Consumes: `Issue`, `IssueClassification`, `IssueReadiness`, `IssuePriority` models; existing `FactorOut` schema in issues.py.
- Produces: `GET /issues/{issue_id}` → `IssueDetailOut` with nullable `classification` / `priority` / `readiness` blocks (exact shape below). Task 5's `IssueDetail` TS type mirrors this 1:1. 404 when the issue doesn't exist.

- [ ] **Step 1: Write the failing tests** — append to `backend/tests/test_api_issues.py` (extend the models import at the top to add `IssuePriority`):

```python
from app.models import (
    Installation,
    Issue,
    IssueClassification,
    IssuePriority,
    IssueReadiness,
    Repository,
)
```

```python
async def seed_priority():
    async with get_sessionmaker()() as session:
        session.add(
            IssuePriority(
                issue_id=1, urgency=80, importance=70,
                factors=[
                    {"axis": "urgency", "sign": "+", "text": "Priority P0 set",
                     "source": "signal", "weight": 30},
                    {"axis": "importance", "sign": "-", "text": "No milestone",
                     "source": "llm", "weight": 0},
                ],
                model="test-model",
                issue_gh_updated_at=NOW - timedelta(days=1),
            )
        )
        await session.commit()


async def set_issue_body(issue_id: int, body: str) -> None:
    async with get_sessionmaker()() as session:
        issue = await session.get(Issue, issue_id)
        issue.body = body
        await session.commit()


async def test_issue_detail_full_payload(clean_db, api):
    await seed_issues()
    await seed_classifications()
    await seed_readiness()
    await seed_priority()
    await set_issue_body(1, "## Repro\n\n1. Log in")
    body = await get_body(api, "/issues/1")
    assert body["number"] == 1
    assert body["title"] == "Alpha bug"
    assert body["body"] == "## Repro\n\n1. Log in"
    assert body["repo_full_name"] == "patelmj/mehova"
    assert body["html_url"] == "https://github.com/patelmj/mehova/issues/1"
    assert body["state"] == "open"
    assert body["author_login"] == "patelmj"
    assert body["labels"] == [{"name": "bug", "color": "d73a4a"}]
    assert body["assignees"] == ["patelmj"]
    assert body["comments_count"] == 5
    assert body["classification"] == {
        "issue_type": "bug", "component": "auth", "confidence": 0.9,
    }
    assert body["priority"]["urgency"] == 80
    assert body["priority"]["importance"] == 70
    assert body["priority"]["factors"][0]["text"] == "Priority P0 set"
    assert body["readiness"]["score"] == 42
    assert body["readiness"]["factors"][1]["present"] is False


async def test_issue_detail_partial_intelligence_is_null(clean_db, api):
    await seed_issues()
    body = await get_body(api, "/issues/2")
    assert body["title"] == "Beta feature"
    assert body["body"] is None
    assert body["classification"] is None
    assert body["priority"] is None
    assert body["readiness"] is None


async def test_issue_detail_404(clean_db, api):
    await seed_issues()
    async with api as client:
        assert (await client.get("/issues/99999")).status_code == 404


async def test_issue_detail_route_does_not_shadow_facets(clean_db, api):
    await seed_issues()
    body = await get_body(api, "/issues/facets")
    assert "labels" in body
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd backend && python -m pytest tests/test_api_issues.py -q`
Expected: the three detail tests FAIL with 404/validation errors (no route); the shadow test PASSES already.

- [ ] **Step 3: Implement the endpoint** — in `backend/app/routers/issues.py`: extend the models import to include `IssuePriority`:

```python
from app.models import Issue, IssueClassification, IssuePriority, IssueReadiness, Repository
```

Append at the END of the file (after `issue_readiness` — keeps `/facets` registered before `/{issue_id}`):

```python
class PriorityFactorOut(BaseModel):
    axis: Literal["urgency", "importance"]
    sign: Literal["+", "-"]
    text: str
    source: Literal["signal", "llm"]
    weight: float


class ClassificationDetail(BaseModel):
    issue_type: str
    component: str | None
    confidence: float


class PriorityDetail(BaseModel):
    urgency: int
    importance: int
    factors: list[PriorityFactorOut]


class ReadinessDetail(BaseModel):
    score: int
    issue_type: str
    factors: list[FactorOut]


class IssueDetailOut(BaseModel):
    id: int
    repository_id: int
    repo_full_name: str
    html_url: str
    number: int
    title: str
    body: str | None
    state: str
    author_login: str
    labels: list[dict]
    assignees: list[str]
    milestone_title: str | None
    comments_count: int
    gh_created_at: datetime
    gh_updated_at: datetime
    gh_closed_at: datetime | None
    classification: ClassificationDetail | None
    priority: PriorityDetail | None
    readiness: ReadinessDetail | None


@router.get("/{issue_id}", response_model=IssueDetailOut)
async def issue_detail(
    issue_id: int, session: AsyncSession = Depends(get_session)
) -> IssueDetailOut:
    row = (
        await session.execute(
            select(
                Issue,
                Repository.full_name,
                IssueClassification,
                IssueReadiness,
                IssuePriority,
            )
            .join(Repository, Issue.repository_id == Repository.id)
            .outerjoin(IssueClassification, IssueClassification.issue_id == Issue.id)
            .outerjoin(IssueReadiness, IssueReadiness.issue_id == Issue.id)
            .outerjoin(IssuePriority, IssuePriority.issue_id == Issue.id)
            .where(Issue.id == issue_id)
        )
    ).first()
    if row is None:
        raise HTTPException(status_code=404, detail="Issue not found")
    issue, full_name, classification, readiness, priority = row
    return IssueDetailOut(
        id=issue.id,
        repository_id=issue.repository_id,
        repo_full_name=full_name,
        html_url=f"https://github.com/{full_name}/issues/{issue.number}",
        number=issue.number,
        title=issue.title,
        body=issue.body,
        state=issue.state,
        author_login=issue.author_login,
        labels=issue.labels,
        assignees=issue.assignees,
        milestone_title=issue.milestone_title,
        comments_count=issue.comments_count,
        gh_created_at=issue.gh_created_at,
        gh_updated_at=issue.gh_updated_at,
        gh_closed_at=issue.gh_closed_at,
        classification=(
            ClassificationDetail(
                issue_type=classification.issue_type,
                component=classification.component,
                confidence=classification.confidence,
            )
            if classification
            else None
        ),
        priority=(
            PriorityDetail(
                urgency=priority.urgency,
                importance=priority.importance,
                factors=[PriorityFactorOut(**f) for f in priority.factors],
            )
            if priority
            else None
        ),
        readiness=(
            ReadinessDetail(
                score=readiness.score,
                issue_type=readiness.issue_type,
                factors=[FactorOut(**f) for f in readiness.factors],
            )
            if readiness
            else None
        ),
    )
```

- [ ] **Step 4: Run tests**

Run: `cd backend && python -m pytest tests/test_api_issues.py -q`
Expected: PASS (all).

- [ ] **Step 5: Full backend suite + lint**

Run: `cd backend && python -m pytest -q && python -m ruff check app tests`
Expected: PASS, ruff clean.

- [ ] **Step 6: Commit**

```bash
git add backend/app/routers/issues.py backend/tests/test_api_issues.py
git commit -m "feat: aggregate issue detail endpoint GET /issues/{id} (#52)"
```

---

### Task 4: Frontend — repository visibility toggle UI + e2e

**Files:**
- Modify: `frontend/src/app/repositories/repositories-client.tsx` (full replacement below)
- Test: `frontend/e2e/repo-visibility.spec.ts` (create)

**Interfaces:**
- Consumes: Task 1's `?include_hidden=true` list, `PATCH /repositories/{id}`, `visible` field. Query-key convention: `["repositories"]` = visible-only (all other pages), `["repositories", "all"]` = management page. Overview stats key is `["overview-stats"]`.
- Produces: visibility toggle button `data-testid="visibility-toggle-<id>"`, hidden pill `data-testid="hidden-pill-<id>"`, card `data-testid="repo-card-<id>"`.

- [ ] **Step 1: Write the failing e2e test** — create `frontend/e2e/repo-visibility.spec.ts`:

```typescript
import { expect, test, type Page } from "@playwright/test";

const baseRepo = {
  private: false,
  last_synced_at: null,
  sync_status: "idle",
  sync_error: null,
};

/** Stateful stub shared by both endpoints: PATCH flips visibility, GETs reflect it. */
async function stubRepos(page: Page, state: { hiddenIds: Set<number> }) {
  const all = () => [
    { ...baseRepo, id: 500, full_name: "patelmj/IssueLens", open_issues_count: 12,
      visible: !state.hiddenIds.has(500) },
    { ...baseRepo, id: 501, full_name: "patelmj/second-repo", open_issues_count: 3,
      visible: !state.hiddenIds.has(501) },
  ];
  await page.route(/\/api\/backend\/repositories(\?.*)?$/, (route) => {
    const url = new URL(route.request().url());
    const json =
      url.searchParams.get("include_hidden") === "true"
        ? all()
        : all().filter((r) => r.visible);
    return route.fulfill({ json });
  });
  await page.route(/\/api\/backend\/repositories\/(\d+)$/, (route) => {
    const id = Number(route.request().url().match(/repositories\/(\d+)$/)![1]);
    const body = route.request().postDataJSON() as { visible: boolean };
    if (body.visible) state.hiddenIds.delete(id);
    else state.hiddenIds.add(id);
    return route.fulfill({ json: all().find((r) => r.id === id) });
  });
}

test("hiding a repo mutes the card and removes it from other views", async ({ page }) => {
  const state = { hiddenIds: new Set<number>() };
  await stubRepos(page, state);

  await page.goto("/repositories");
  await expect(page.getByTestId("repo-card-501")).toBeVisible();
  await expect(page.getByTestId("hidden-pill-501")).toHaveCount(0);

  await page.getByTestId("visibility-toggle-501").click();
  await expect(page.getByTestId("hidden-pill-501")).toBeVisible();
  // card stays present (muted), never removed
  await expect(page.getByTestId("repo-card-501")).toBeVisible();
  await expect(page.getByTestId("visibility-toggle-501")).toHaveText("Show");

  // the plan table's repo select no longer offers the hidden repo
  await page.goto("/plan");
  await expect(page.getByLabel("Repository").locator("option")).toHaveText([
    "All repositories",
    "patelmj/IssueLens",
  ]);
});

test("showing a hidden repo restores it", async ({ page }) => {
  const state = { hiddenIds: new Set<number>([501]) };
  await stubRepos(page, state);

  await page.goto("/repositories");
  await expect(page.getByTestId("hidden-pill-501")).toBeVisible();
  await page.getByTestId("visibility-toggle-501").click();
  await expect(page.getByTestId("hidden-pill-501")).toHaveCount(0);
  await expect(page.getByTestId("visibility-toggle-501")).toHaveText("Hide");
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd frontend && npx playwright test e2e/repo-visibility.spec.ts`
Expected: FAIL — `visibility-toggle-501` not found.

- [ ] **Step 3: Replace `frontend/src/app/repositories/repositories-client.tsx`** with:

```tsx
"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { getJson, sendJson } from "../../lib/api";
import { relativeTime } from "../../lib/time";

type Repo = {
  id: number;
  full_name: string;
  private: boolean;
  open_issues_count: number;
  last_synced_at: string | null;
  sync_status: "idle" | "syncing" | "error";
  sync_error: string | null;
  visible: boolean;
};

const STATUS_DOT: Record<Repo["sync_status"], string> = {
  idle: "bg-(--color-text-muted)",
  syncing: "bg-(--color-primary)",
  error: "bg-(--color-danger)",
};

const card =
  "rounded-[14px] border border-(--color-border) bg-(--color-surface) shadow-(--shadow-card)";
const btn =
  "rounded-lg border border-(--color-border) bg-(--color-surface) px-2.5 py-1.5 text-(--color-primary) transition-all duration-150 hover:bg-(--accent-tint) disabled:text-(--color-text-muted) disabled:hover:bg-(--color-surface)";

const ALL_REPOS_KEY = ["repositories", "all"] as const;

export function RepositoriesClient() {
  const queryClient = useQueryClient();
  const [visibilityError, setVisibilityError] = useState<string | null>(null);
  const { data: repos, error, isPending } = useQuery({
    queryKey: ALL_REPOS_KEY,
    queryFn: () =>
      getJson<Repo[]>("/api/backend/repositories?include_hidden=true"),
    refetchInterval: (query) =>
      query.state.data?.some((r) => r.sync_status === "syncing") ? 3000 : false,
  });
  const refresh = useMutation({
    mutationFn: () =>
      getJson<Repo[]>("/api/backend/repositories/refresh", { method: "POST" }),
    onSuccess: (data) => {
      queryClient.setQueryData(ALL_REPOS_KEY, data);
      queryClient.invalidateQueries({ queryKey: ["repositories"], exact: true });
    },
  });
  const sync = useMutation({
    mutationFn: (id: number) =>
      getJson<{ queued: boolean }>(`/api/backend/repositories/${id}/sync`, {
        method: "POST",
      }),
    onSuccess: (_data, id) => {
      queryClient.setQueryData<Repo[]>(ALL_REPOS_KEY, (old) =>
        old?.map((r) => (r.id === id ? { ...r, sync_status: "syncing" } : r)),
      );
    },
  });
  const visibility = useMutation({
    mutationFn: ({ id, visible }: { id: number; visible: boolean }) =>
      sendJson<Repo>(`/api/backend/repositories/${id}`, "PATCH", { visible }),
    onMutate: () => setVisibilityError(null),
    onSuccess: (updated) => {
      queryClient.setQueryData<Repo[]>(ALL_REPOS_KEY, (old) =>
        old?.map((r) => (r.id === updated.id ? updated : r)),
      );
      queryClient.invalidateQueries({ queryKey: ["repositories"], exact: true });
      queryClient.invalidateQueries({ queryKey: ["overview-stats"] });
    },
    onError: (err) => setVisibilityError(err.message),
  });

  return (
    <div className="flex flex-col gap-4" data-testid="repositories-content">
      <div className="flex items-baseline gap-3">
        <h1 className="text-lg font-semibold tracking-[-0.01em]">Repositories</h1>
        <span className="text-(--color-text-muted)">Connected sources</span>
        <div className="grow" />
        <button
          type="button"
          className={btn}
          onClick={() => refresh.mutate()}
          disabled={refresh.isPending}
        >
          {refresh.isPending ? "Refreshing…" : "Refresh from GitHub"}
        </button>
      </div>

      {refresh.error ? (
        <div className={`${card} px-4 py-3 text-(--color-danger)`}>
          {refresh.error.message}
        </div>
      ) : null}
      {visibilityError ? (
        <div className={`${card} px-4 py-3 text-(--color-danger)`} data-testid="visibility-error">
          {visibilityError}
        </div>
      ) : null}

      {isPending ? (
        <div className={`${card} px-6 py-16 text-center text-(--color-text-muted)`}>
          Loading repositories…
        </div>
      ) : error ? (
        <div className={`${card} px-6 py-16 text-center`}>
          <div className="text-sm font-medium">Backend unavailable</div>
          <div className="pt-1.5 text-(--color-text-muted)">{error.message}</div>
        </div>
      ) : !repos || repos.length === 0 ? (
        <div className={`${card} flex flex-col items-center gap-1.5 px-6 py-16 text-center`}>
          <div className="text-sm font-medium">Connect GitHub</div>
          <div className="max-w-md text-(--color-text-muted)">
            Install your IssueLens GitHub App on the repositories you want to
            sync (see the README&apos;s &ldquo;GitHub App setup&rdquo;), then
            refresh. Repositories the App can reach will appear here.
          </div>
          <a
            className="pt-2 text-(--color-primary) hover:underline"
            href="https://github.com/settings/apps"
            target="_blank"
            rel="noreferrer"
          >
            Open GitHub App settings ↗
          </a>
        </div>
      ) : (
        <ul className="flex flex-col gap-2">
          {repos.map((repo) => (
            <li
              key={repo.id}
              data-testid={`repo-card-${repo.id}`}
              className={`${card} flex items-center gap-3 px-4 py-3`}
            >
              <span
                className={`inline-block h-2 w-2 rounded-full ${STATUS_DOT[repo.sync_status]}`}
                title={`Sync status: ${repo.sync_status}`}
              />
              <span
                className={`font-medium ${repo.visible ? "" : "text-(--color-text-muted)"}`}
              >
                {repo.full_name}
              </span>
              {repo.private ? (
                <span className="rounded-full border border-(--color-border) px-1.5 text-[10px] text-(--color-text-muted)">
                  private
                </span>
              ) : null}
              {!repo.visible ? (
                <span
                  data-testid={`hidden-pill-${repo.id}`}
                  className="rounded-full border border-(--color-border) px-1.5 text-[10px] text-(--color-text-muted)"
                >
                  hidden
                </span>
              ) : null}
              <span className="text-(--color-text-muted)">
                {repo.open_issues_count} open issues
              </span>
              <div className="grow" />
              {repo.sync_status === "error" && repo.sync_error ? (
                <span className="max-w-xs truncate text-(--color-danger)" title={repo.sync_error}>
                  {repo.sync_error}
                </span>
              ) : null}
              <span className="text-(--color-text-muted)">
                synced {relativeTime(repo.last_synced_at)}
              </span>
              <button
                type="button"
                data-testid={`visibility-toggle-${repo.id}`}
                aria-pressed={repo.visible}
                title={
                  repo.visible
                    ? "Hide this repository from selects and aggregate views (it keeps syncing)"
                    : "Show this repository everywhere again"
                }
                className={btn}
                onClick={() =>
                  visibility.mutate({ id: repo.id, visible: !repo.visible })
                }
                disabled={visibility.isPending}
              >
                {repo.visible ? "Hide" : "Show"}
              </button>
              <button
                type="button"
                className={btn}
                onClick={() => sync.mutate(repo.id)}
                disabled={repo.sync_status === "syncing"}
              >
                {repo.sync_status === "syncing" ? "Syncing…" : "Sync"}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
```

- [ ] **Step 4: Run the e2e + existing repositories spec**

Run: `cd frontend && npx playwright test e2e/repo-visibility.spec.ts e2e/repositories.spec.ts`
Expected: PASS. (Note: `repositories.spec.ts`'s empty-state test routes `/api/backend/repositories$` without query — the page now requests `?include_hidden=true`, so if it fails, update that route pattern to `/\/api\/backend\/repositories(\?.*)?$/`.)

- [ ] **Step 5: Lint**

Run: `cd frontend && npm run lint`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/app/repositories/repositories-client.tsx frontend/e2e/repo-visibility.spec.ts frontend/e2e/repositories.spec.ts
git commit -m "feat: repository visibility toggles on /repositories (#55)"
```

---

### Task 5: Frontend — react-markdown deps + IssueDetailPanel component

**Files:**
- Modify: `frontend/package.json` (via npm install)
- Create: `frontend/src/components/issue-detail-panel.tsx`

**Interfaces:**
- Consumes: Task 3's `GET /issues/{issue_id}` payload; `getJson` from `../lib/api`; `relativeTime` from `../lib/time`.
- Produces: `IssueDetailPanel({ issueId, onBack }: { issueId: number; onBack: () => void })` — self-fetching, query key `["issue-detail", issueId]`. Test ids: `issue-detail-panel`, `detail-back`, `detail-body`, `detail-readiness`, `detail-priority`, `detail-github-link`. Task 6 mounts it.

- [ ] **Step 1: Install the approved dependencies**

Run: `cd frontend && npm install react-markdown remark-gfm`
Expected: both added to `package.json` dependencies, no peer-dep errors (react-markdown v10 supports React 19).

- [ ] **Step 2: Create `frontend/src/components/issue-detail-panel.tsx`**

```tsx
"use client";

import { useQuery } from "@tanstack/react-query";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { getJson } from "../lib/api";
import { relativeTime } from "../lib/time";

type ReadinessFactor = {
  requirement: string;
  points: number;
  present: boolean;
  evidence: string | null;
};

type PriorityFactor = {
  axis: "urgency" | "importance";
  sign: "+" | "-";
  text: string;
  source: "signal" | "llm";
  weight: number;
};

type IssueDetail = {
  id: number;
  repository_id: number;
  repo_full_name: string;
  html_url: string;
  number: number;
  title: string;
  body: string | null;
  state: string;
  author_login: string;
  labels: { name: string; color: string }[];
  assignees: string[];
  milestone_title: string | null;
  comments_count: number;
  gh_created_at: string;
  gh_updated_at: string;
  gh_closed_at: string | null;
  classification: {
    issue_type: string;
    component: string | null;
    confidence: number;
  } | null;
  priority: {
    urgency: number;
    importance: number;
    factors: PriorityFactor[];
  } | null;
  readiness: {
    score: number;
    issue_type: string;
    factors: ReadinessFactor[];
  } | null;
};

const btn =
  "rounded-lg border border-(--color-border) bg-(--color-surface) px-2.5 py-1 text-(--color-primary) transition-all duration-150 hover:bg-(--accent-tint)";

const sectionLabel =
  "text-[10px] font-semibold tracking-[0.08em] text-(--color-text-muted) uppercase";

/* GitHub bodies render with the app's tokens; raw HTML is ignored (react-markdown
   default) and images become links so the narrow rail never loads remote media. */
const MD_COMPONENTS: Components = {
  h1: ({ children }) => <h4 className="pt-1 text-sm font-semibold">{children}</h4>,
  h2: ({ children }) => <h4 className="pt-1 text-sm font-semibold">{children}</h4>,
  h3: ({ children }) => <h4 className="pt-1 font-semibold">{children}</h4>,
  p: ({ children }) => <p className="leading-relaxed">{children}</p>,
  ul: ({ children }) => <ul className="list-disc pl-4">{children}</ul>,
  ol: ({ children }) => <ol className="list-decimal pl-4">{children}</ol>,
  li: ({ children }) => <li className="pb-0.5">{children}</li>,
  a: ({ href, children }) => (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="text-(--color-primary) hover:underline"
    >
      {children}
    </a>
  ),
  code: ({ children }) => (
    <code className="rounded bg-(--color-bg) px-1 py-0.5 font-mono text-[11px]">
      {children}
    </code>
  ),
  pre: ({ children }) => (
    <pre className="overflow-x-auto rounded-lg border border-(--color-border) bg-(--color-bg) p-2 font-mono text-[11px]">
      {children}
    </pre>
  ),
  blockquote: ({ children }) => (
    <blockquote className="border-l-2 border-(--color-border) pl-2 text-(--color-text-muted)">
      {children}
    </blockquote>
  ),
  table: ({ children }) => (
    <div className="overflow-x-auto">
      <table className="border-collapse text-[11px]">{children}</table>
    </div>
  ),
  th: ({ children }) => (
    <th className="border border-(--color-border) px-1.5 py-0.5 text-left font-semibold">
      {children}
    </th>
  ),
  td: ({ children }) => (
    <td className="border border-(--color-border) px-1.5 py-0.5">{children}</td>
  ),
  img: ({ src, alt }) => (
    <a
      href={typeof src === "string" ? src : undefined}
      target="_blank"
      rel="noreferrer"
      className="text-(--color-primary) hover:underline"
    >
      {alt || "image"} ↗
    </a>
  ),
};

export function IssueDetailPanel({
  issueId,
  onBack,
}: {
  issueId: number;
  onBack: () => void;
}) {
  const { data, error, isPending, refetch } = useQuery({
    queryKey: ["issue-detail", issueId],
    queryFn: () => getJson<IssueDetail>(`/api/backend/issues/${issueId}`),
  });

  const missing = data?.readiness?.factors.filter((f) => !f.present) ?? [];

  return (
    <div
      className="flex max-h-[calc(100vh-120px)] flex-col gap-3 overflow-y-auto rounded-[14px] border border-(--color-border) bg-(--color-surface) p-4 shadow-(--shadow-card)"
      data-testid="issue-detail-panel"
    >
      <div className="flex items-center gap-2">
        <button type="button" data-testid="detail-back" className={btn} onClick={onBack}>
          ← Queue
        </button>
        <span className="min-w-0 truncate text-(--color-text-muted)">
          {data?.repo_full_name ?? ""}
        </span>
      </div>

      {isPending ? (
        <div className="text-(--color-text-muted)">Loading issue…</div>
      ) : error ? (
        <div className="flex flex-col items-start gap-2">
          <span className="text-(--color-danger)">
            Could not load the issue: {error.message}
          </span>
          <button type="button" className={btn} onClick={() => refetch()}>
            Retry
          </button>
        </div>
      ) : (
        <>
          <div className="text-(--color-text-muted)">
            #{data.number} · {data.state} · @{data.author_login} · opened{" "}
            {relativeTime(data.gh_created_at)}
            {data.comments_count > 0 ? ` · ${data.comments_count} comments` : ""}
            {data.milestone_title ? ` · ${data.milestone_title}` : ""}
          </div>
          <h2 className="text-sm font-semibold">{data.title}</h2>

          {data.labels.length > 0 || data.assignees.length > 0 ? (
            <div className="flex flex-wrap items-center gap-1.5">
              {data.labels.map((label) => (
                <span
                  key={label.name}
                  className="flex items-center gap-1 rounded-full border border-(--color-border) px-1.5 py-0.5 text-[10px]"
                >
                  <span
                    className="inline-block h-2 w-2 rounded-full"
                    style={{
                      background: label.color
                        ? `#${label.color}`
                        : "var(--color-text-muted)",
                    }}
                  />
                  {label.name}
                </span>
              ))}
              {data.assignees.map((login) => (
                <span
                  key={login}
                  className="rounded-full border border-(--color-border) px-1.5 py-0.5 text-[10px] text-(--color-text-muted)"
                >
                  @{login}
                </span>
              ))}
            </div>
          ) : null}

          <div className="flex flex-col gap-2" data-testid="detail-body">
            {data.body ? (
              <ReactMarkdown remarkPlugins={[remarkGfm]} components={MD_COMPONENTS}>
                {data.body}
              </ReactMarkdown>
            ) : (
              <span className="text-(--color-text-muted)">
                No description provided.
              </span>
            )}
          </div>

          {data.readiness ? (
            <div className="flex flex-col gap-1.5" data-testid="detail-readiness">
              <div className="flex items-center justify-between">
                <span className={sectionLabel}>Readiness</span>
                <span className="tabular-nums">{data.readiness.score}/100</span>
              </div>
              <div className="h-1.5 overflow-hidden rounded-full border border-(--color-border) bg-(--color-bg)">
                <div
                  className="h-full rounded-full bg-(--color-primary)"
                  style={{ width: `${data.readiness.score}%` }}
                />
              </div>
              {missing.length > 0 ? (
                <ul className="flex flex-col gap-0.5">
                  {missing.map((f) => (
                    <li key={f.requirement} className="text-(--type-bug)">
                      − {f.requirement}
                    </li>
                  ))}
                </ul>
              ) : (
                <span className="text-(--color-text-muted)">Everything covered</span>
              )}
            </div>
          ) : null}

          {data.classification ? (
            <div className="text-(--color-text-muted)" data-testid="detail-classification">
              Classified {data.classification.issue_type}
              {data.classification.component
                ? ` · ${data.classification.component}`
                : ""}{" "}
              · {Math.round(data.classification.confidence * 100)}% confidence
            </div>
          ) : null}

          {data.priority ? (
            <div className="flex flex-col gap-1" data-testid="detail-priority">
              <div className="flex items-center justify-between">
                <span className={sectionLabel}>Priority factors</span>
                <span className="tabular-nums text-(--color-text-muted)">
                  U {Math.round(data.priority.urgency)} · I{" "}
                  {Math.round(data.priority.importance)}
                </span>
              </div>
              <ul className="flex flex-col gap-0.5">
                {data.priority.factors.map((f) => (
                  <li
                    key={`${f.axis}-${f.text}`}
                    className={
                      f.sign === "+" ? "text-(--type-feature)" : "text-(--type-bug)"
                    }
                  >
                    {f.sign} {f.text}
                    <span className="text-(--color-text-muted)"> · {f.axis}</span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          <a
            href={data.html_url}
            target="_blank"
            rel="noreferrer"
            data-testid="detail-github-link"
            className="mt-1 text-(--color-primary) hover:underline"
          >
            Open on GitHub ↗
          </a>
        </>
      )}
    </div>
  );
}
```

- [ ] **Step 3: Verify it compiles and lints**

Run: `cd frontend && npx tsc --noEmit && npm run lint`
Expected: clean. (The component is not mounted anywhere yet — that's Task 6.)

- [ ] **Step 4: Commit**

```bash
git add frontend/package.json frontend/package-lock.json frontend/src/components/issue-detail-panel.tsx
git commit -m "feat: reusable IssueDetailPanel with markdown body rendering (#52)"
```

---

### Task 6: Frontend — matrix integration (queue click → drawer) + e2e

**Files:**
- Modify: `frontend/src/app/plan/matrix/execution-queue.tsx` (prop change)
- Modify: `frontend/src/app/plan/matrix/matrix-client.tsx` (state + rail swap + Esc)
- Test: `frontend/e2e/issue-detail.spec.ts` (create)

**Interfaces:**
- Consumes: `IssueDetailPanel({ issueId, onBack })` from Task 5 (import from `../../../components/issue-detail-panel`); queue test ids `qrow-<number>`, panel test ids from Task 5.
- Produces: `ExecutionQueue` prop change — `onSelect: (id: number | null) => void` is REPLACED by `onOpen: (id: number) => void` (grep for all `<ExecutionQueue` usages to catch any call site beyond matrix-client). Row click selects AND opens; ← back / Esc restores the queue with selection intact.

- [ ] **Step 1: Write the failing e2e test** — create `frontend/e2e/issue-detail.spec.ts`:

```typescript
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
  readiness_score: 64,
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
  items: [item(), item({ issue_id: 2, number: 43, title: "Docs typo", urgency: 20, importance: 15, issue_type: "docs" })],
  total: 2,
  scored: 2,
  unscored: 0,
};

const detail = {
  id: 1,
  repository_id: 500,
  repo_full_name: "patelmj/mehova",
  html_url: "https://github.com/patelmj/mehova/issues/42",
  number: 42,
  title: "Fix token refresh",
  body: "## Repro\n\n1. Log in\n2. Wait for the token to expire",
  state: "open",
  author_login: "sam",
  labels: [{ name: "bug", color: "d73a4a" }],
  assignees: ["sam"],
  milestone_title: null,
  comments_count: 3,
  gh_created_at: "2026-07-20T00:00:00Z",
  gh_updated_at: "2026-07-21T00:00:00Z",
  gh_closed_at: null,
  classification: { issue_type: "bug", component: "auth", confidence: 0.9 },
  priority: {
    urgency: 80,
    importance: 70,
    factors: [
      { axis: "urgency", sign: "+", text: "Priority P0 set", source: "signal", weight: 30 },
    ],
  },
  readiness: {
    score: 64,
    issue_type: "bug",
    factors: [
      { requirement: "Reproduction steps", points: 20, present: false, evidence: null },
    ],
  },
};

async function stubRoutes(page: Page) {
  await page.route(/\/api\/backend\/repositories$/, (route: Route) =>
    route.fulfill({ json: [{ id: 500, full_name: "patelmj/mehova" }] }),
  );
  await page.route(/\/api\/backend\/repositories\/500\/priority$/, (route: Route) =>
    route.fulfill({ json: matrixPayload }),
  );
  await page.route(/\/api\/backend\/issues\/1$/, (route: Route) =>
    route.fulfill({ json: detail }),
  );
}

test("queue row click opens the detail drawer; back restores the queue", async ({ page }) => {
  await stubRoutes(page);
  await page.goto("/plan/matrix");
  await page.getByTestId("qrow-42").click();

  const panel = page.getByTestId("issue-detail-panel");
  await expect(panel).toBeVisible();
  await expect(page.getByTestId("execution-queue")).toHaveCount(0);
  await expect(panel.getByRole("heading", { name: "Fix token refresh" })).toBeVisible();
  await expect(panel.getByRole("heading", { name: "Repro" })).toBeVisible();
  await expect(panel.getByText("64/100")).toBeVisible();
  await expect(panel.getByText("− Reproduction steps")).toBeVisible();
  await expect(panel.getByText("+ Priority P0 set")).toBeVisible();
  await expect(panel.getByTestId("detail-github-link")).toHaveAttribute(
    "href",
    detail.html_url,
  );

  await page.getByTestId("detail-back").click();
  await expect(page.getByTestId("execution-queue")).toBeVisible();
  await expect(page.getByTestId("qrow-42")).toHaveClass(/accent-tint/);
});

test("Escape closes the drawer and restores the queue", async ({ page }) => {
  await stubRoutes(page);
  await page.goto("/plan/matrix");
  await page.getByTestId("qrow-42").click();
  await expect(page.getByTestId("issue-detail-panel")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("execution-queue")).toBeVisible();
});

test("detail endpoint failure shows an error with retry", async ({ page }) => {
  await stubRoutes(page);
  await page.route(/\/api\/backend\/issues\/1$/, (route: Route) =>
    route.fulfill({ status: 500, json: { detail: "boom" } }),
  );
  await page.goto("/plan/matrix");
  await page.getByTestId("qrow-42").click();
  await expect(page.getByText(/Could not load the issue/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Retry" })).toBeVisible();
});
```

Note: the minus in `"− Reproduction steps"` is U+2212 (matching the panel code), not an ASCII hyphen.

- [ ] **Step 2: Run it to verify it fails**

Run: `cd frontend && npx playwright test e2e/issue-detail.spec.ts`
Expected: FAIL — clicking `qrow-42` only selects; no `issue-detail-panel`.

- [ ] **Step 3: Change the ExecutionQueue contract** — in `frontend/src/app/plan/matrix/execution-queue.tsx`, replace the component signature and the row's onClick. First grep for every call site (do not assume matrix-client is the only one):

Run: `cd frontend && grep -rn "ExecutionQueue" src/`

Signature change:

```tsx
export function ExecutionQueue({
  plotted,
  selectedId,
  onOpen,
  onRelease,
}: {
  plotted: PlottedItem[];
  selectedId: number | null;
  onOpen: (id: number) => void;
  onRelease: (issueId: number) => void;
}) {
```

Row button onClick (was the `onSelect(selectedId === … ? null : …)` toggle):

```tsx
                    onClick={() => onOpen(item.issue_id)}
```

- [ ] **Step 4: Integrate in matrix-client** — in `frontend/src/app/plan/matrix/matrix-client.tsx`:

Add the import:

```tsx
import { IssueDetailPanel } from "../../../components/issue-detail-panel";
```

Extend the react import to include `useEffect`:

```tsx
import { useCallback, useEffect, useState } from "react";
```

After the `selectedId` state (line ~131), add:

```tsx
  const [detailIssueId, setDetailIssueId] = useState<number | null>(null);

  const openDetail = useCallback((issueId: number) => {
    setSelectedId(issueId);
    setDetailIssueId(issueId);
  }, []);

  useEffect(() => {
    if (detailIssueId == null) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setDetailIssueId(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [detailIssueId]);
```

Close the drawer on repo switch — in the repo `<select>` onChange:

```tsx
          onChange={(e) => {
            setDetailIssueId(null);
            navigateWith(e.target.value ? Number(e.target.value) : null, filters);
          }}
```

Bubble click opens the drawer too (spec §10.4) — change `MatrixChart`'s `onSelect` prop from `onSelect={setSelectedId}` to:

```tsx
              onSelect={(id) => {
                setSelectedId(id);
                setDetailIssueId(id);
              }}
```

(A background/deselect click passes `null`, which also closes the drawer — intended.)

Swap the rail content:

```tsx
          <RightRail>
            {detailIssueId != null ? (
              <IssueDetailPanel
                issueId={detailIssueId}
                onBack={() => setDetailIssueId(null)}
              />
            ) : (
              <ExecutionQueue
                plotted={plotted}
                selectedId={selectedId}
                onOpen={openDetail}
                onRelease={(issueId) => releaseMutation.mutate(issueId)}
              />
            )}
          </RightRail>
```

- [ ] **Step 5: Run the new e2e file**

Run: `cd frontend && npx playwright test e2e/issue-detail.spec.ts`
Expected: PASS (3 tests).

- [ ] **Step 6: Run the full matrix e2e set (regression: old specs click queue rows expecting select-only)**

Run: `cd frontend && npx playwright test e2e/matrix.spec.ts e2e/matrix-filters.spec.ts e2e/matrix-layout.spec.ts e2e/matrix-pins.spec.ts e2e/matrix-collision.spec.ts`
Expected: mostly PASS. Any spec that clicks a `qrow-*` and then asserts on the queue will now see the drawer instead — update those assertions to click `detail-back` first (or assert against the drawer), preserving each test's original intent. If a spec asserts bubble-click behavior, it now also opens the drawer; adjust the same way. Do NOT weaken pin/drag assertions — drag behavior is unchanged.

- [ ] **Step 7: Full frontend verification**

Run: `cd frontend && npx tsc --noEmit && npm run lint && npx playwright test`
Expected: all clean/PASS.

- [ ] **Step 8: Commit**

```bash
git add frontend/src/app/plan/matrix/execution-queue.tsx frontend/src/app/plan/matrix/matrix-client.tsx frontend/e2e/issue-detail.spec.ts
git commit -m "feat: execution-queue row and bubble click open the issue detail drawer (#52)"
```

(Include any matrix e2e specs updated in Step 6 in the `git add`.)

---

## Final verification (after all tasks)

- [ ] `cd backend && python -m pytest -q && python -m ruff check app tests` — all pass.
- [ ] `cd frontend && npx tsc --noEmit && npm run lint && npx playwright test` — all pass.
- [ ] Windows dev-server hygiene: if a background `npm run dev` was started, after stopping it verify no orphan remains: `netstat -ano | findstr :3005` and `Stop-Process` the node PID if one lingers.
- [ ] Whole-branch review (most-capable model) before asking the user about a PR.
