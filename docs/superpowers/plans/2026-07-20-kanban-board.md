# Kanban Board Implementation Plan (#9)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A per-repo Kanban board at `/plan/board` with the six-column workflow, IssueLens-owned sticky manual placement (closed-wins), Component/Assignee swimlanes, and developer-centric cards.

**Architecture:** One new table `issue_workflow` stores *only* manual placements; every card's column is derived at read time in `GET /repositories/{id}/kanban` (closed → Done always; manual row wins for open issues; otherwise a signal ladder). Frontend mirrors the matrix page's structure: React Query + optimistic mutations, pointer-event drag, Playwright e2e against a stateful stub.

**Tech Stack:** FastAPI + SQLAlchemy async + Alembic (backend), Next.js App Router + TanStack Query + Tailwind v4 (frontend), pytest + Playwright CLI (tests).

**Spec:** `docs/superpowers/specs/2026-07-20-kanban-design.md` — read it first.

## Global Constraints

- Backend commands run from `backend/`: `uv run pytest ...`, `uv run ruff check .`. Frontend commands run from `frontend/`: `npm run lint`, `npm run build`, `npm run test:e2e`.
- Backend tests need `docker compose up -d postgres redis` (pytest creates/migrates `issuelens_test` itself; dev data untouched).
- Tailwind v4: CSS variables use **parentheses** syntax `bg-(--color-X)` — never `bg-[--color-X]` brackets.
- Keep UI elements visible-but-muted when empty/inactive; never hide or reshape them.
- Commit messages: no AI attribution, no Co-Authored-By lines.
- No new dependencies.
- Workflow column values everywhere (DB, API, frontend): `needs_detail`, `ready`, `in_progress`, `review`, `blocked`, `done` — in that display order. The DB/model attribute is `wf_column` (avoids the reserved word `column`); the JSON field is `column`.
- Frontend note: this Next.js version may differ from your training data (`frontend/AGENTS.md`); follow the existing files' patterns exactly — they are proven against this version. UI implementers should invoke `Skill("sketch-findings-issuelens")` before styling.
- Model tiers for subagent dispatch (per CLAUDE.md): tier is noted per task; every review/fix re-review is **sonnet**; final whole-branch review is **most-capable**.

---

### Task 1: `issue_workflow` table — migration, model, conftest

**Model tier:** haiku (transcription — complete code below)

**Files:**
- Create: `backend/alembic/versions/0008_issue_workflow.py`
- Modify: `backend/app/models.py` (insert after `IssuePriorityPin`, before `SyncJob`)
- Modify: `backend/tests/conftest.py:70-72` (truncate list)
- Test: `backend/tests/test_models_workflow.py`

**Interfaces:**
- Produces: `app.models.IssueWorkflow` with `issue_id: int` (PK), `wf_column: str`, `moved_at: datetime` — Tasks 3/4 import it.

- [ ] **Step 1: Write the failing test**

Create `backend/tests/test_models_workflow.py`:

```python
from datetime import datetime, timezone

import pytest
from sqlalchemy import delete, select
from sqlalchemy.exc import IntegrityError

from app.db import get_sessionmaker
from app.models import Installation, Issue, IssueWorkflow, Repository

JULY_1 = datetime(2026, 7, 1, tzinfo=timezone.utc)


async def seed_issue(session) -> None:
    session.add(Installation(id=42, account_login="patelmj"))
    await session.flush()
    session.add(
        Repository(id=500, installation_id=42, full_name="patelmj/mehova",
                   owner="patelmj", name="mehova")
    )
    await session.flush()
    session.add(
        Issue(id=1, number=10, title="t", state="open", repository_id=500,
              body="b", gh_created_at=JULY_1, gh_updated_at=JULY_1)
    )
    await session.flush()


async def test_workflow_roundtrip_and_cascade(clean_db):
    async with get_sessionmaker()() as session:
        await seed_issue(session)
        session.add(IssueWorkflow(issue_id=1, wf_column="ready"))
        await session.commit()

    async with get_sessionmaker()() as session:
        row = (
            await session.execute(select(IssueWorkflow).where(IssueWorkflow.issue_id == 1))
        ).scalar_one()
        assert row.wf_column == "ready"
        assert row.moved_at is not None
        await session.execute(delete(Issue).where(Issue.id == 1))
        await session.commit()

    async with get_sessionmaker()() as session:
        gone = (
            await session.execute(select(IssueWorkflow).where(IssueWorkflow.issue_id == 1))
        ).scalar_one_or_none()
        assert gone is None


async def test_workflow_rejects_unknown_column(clean_db):
    async with get_sessionmaker()() as session:
        await seed_issue(session)
        session.add(IssueWorkflow(issue_id=1, wf_column="parked"))
        with pytest.raises(IntegrityError):
            await session.commit()
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && uv run pytest tests/test_models_workflow.py -v`
Expected: FAIL — `ImportError: cannot import name 'IssueWorkflow'`

- [ ] **Step 3: Add the model**

In `backend/app/models.py`, insert between `IssuePriorityPin` and `SyncJob`:

```python
class IssueWorkflow(Base):
    __tablename__ = "issue_workflow"

    issue_id: Mapped[int] = mapped_column(
        BigInteger, ForeignKey("issues.id", ondelete="CASCADE"), primary_key=True
    )
    wf_column: Mapped[str] = mapped_column(Text)
    moved_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )
```

- [ ] **Step 4: Write the migration**

Create `backend/alembic/versions/0008_issue_workflow.py`:

```python
"""issue workflow placements (kanban)"""

import sqlalchemy as sa
from alembic import op

revision = "0008"
down_revision = "0007"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "issue_workflow",
        sa.Column(
            "issue_id",
            sa.BigInteger(),
            sa.ForeignKey("issues.id", ondelete="CASCADE"),
            primary_key=True,
        ),
        sa.Column("wf_column", sa.Text(), nullable=False),
        sa.Column(
            "moved_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.CheckConstraint(
            "wf_column IN ('needs_detail', 'ready', 'in_progress', 'review', "
            "'blocked', 'done')",
            name="ck_issue_workflow_column",
        ),
    )


def downgrade() -> None:
    op.drop_table("issue_workflow")
```

- [ ] **Step 5: Add the table to the conftest truncate list**

In `backend/tests/conftest.py`, the `clean_db` fixture's TRUNCATE statement currently reads:

```python
                "TRUNCATE installations, repositories, issues, issue_classifications, "
                "issue_readiness, issue_priority, issue_priority_pins, sync_jobs "
                "RESTART IDENTITY CASCADE"
```

Change to:

```python
                "TRUNCATE installations, repositories, issues, issue_classifications, "
                "issue_readiness, issue_priority, issue_priority_pins, issue_workflow, "
                "sync_jobs RESTART IDENTITY CASCADE"
```

- [ ] **Step 6: Run test to verify it passes**

Run: `cd backend && uv run pytest tests/test_models_workflow.py -v`
Expected: 2 PASS (the session-scoped fixture migrates `issuelens_test` to head, applying 0008)

- [ ] **Step 7: Lint and commit**

```bash
cd backend && uv run ruff check .
git add backend/alembic/versions/0008_issue_workflow.py backend/app/models.py backend/tests/conftest.py backend/tests/test_models_workflow.py
git commit -m "feat: issue_workflow table for kanban manual placements"
```

---

### Task 2: Column derivation ladder (pure function)

**Model tier:** haiku (transcription — complete code below)

**Files:**
- Create: `backend/app/workflow.py`
- Test: `backend/tests/test_workflow.py`

**Interfaces:**
- Produces: `app.workflow.WORKFLOW_COLUMNS: tuple[str, ...]` (the six values in display order) and `app.workflow.derive_column(*, state, labels, assignees, readiness_score, placed_column) -> str` — Task 3 imports both.

- [ ] **Step 1: Write the failing table-driven test**

Create `backend/tests/test_workflow.py`:

```python
import pytest

from app.workflow import WORKFLOW_COLUMNS, derive_column

CASES = [
    # (id, state, labels, assignees, readiness, placed, expected)
    ("closed_wins_over_placed", "closed", [], [], None, "in_progress", "done"),
    ("closed_wins_bare", "closed", [], ["dev"], 90, None, "done"),
    ("placed_wins_over_signals", "open", [{"name": "blocked"}], ["dev"], 90, "review", "review"),
    ("placed_done_stays_done", "open", [], [], None, "done", "done"),
    ("blocked_label", "open", [{"name": "blocked"}], [], 90, None, "blocked"),
    ("blocked_label_case_insensitive", "open", [{"name": "Blocked"}], [], None, None, "blocked"),
    ("blocked_beats_assignee", "open", [{"name": "BLOCKED"}], ["dev"], None, None, "blocked"),
    ("assignee_in_progress", "open", [], ["dev"], 90, None, "in_progress"),
    ("readiness_at_threshold", "open", [], [], 70, None, "ready"),
    ("readiness_below_threshold", "open", [], [], 69, None, "needs_detail"),
    ("no_signals", "open", [], [], None, None, "needs_detail"),
    ("other_labels_ignored", "open", [{"name": "bug"}, {"name": "blocked-on-upstream"}], [], None, None, "needs_detail"),
]


@pytest.mark.parametrize(
    "state,labels,assignees,readiness,placed,expected",
    [c[1:] for c in CASES],
    ids=[c[0] for c in CASES],
)
def test_derive_column(state, labels, assignees, readiness, placed, expected):
    assert (
        derive_column(
            state=state,
            labels=labels,
            assignees=assignees,
            readiness_score=readiness,
            placed_column=placed,
        )
        == expected
    )


def test_column_order():
    assert WORKFLOW_COLUMNS == (
        "needs_detail", "ready", "in_progress", "review", "blocked", "done",
    )
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && uv run pytest tests/test_workflow.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'app.workflow'`

- [ ] **Step 3: Implement**

Create `backend/app/workflow.py`:

```python
"""Workflow-column derivation for the Kanban board.

Columns are derived at read time from GitHub signals unless the user manually
placed the card (an issue_workflow row), which is sticky. A closed issue always
displays in Done; its manual placement (if any) is retained so reopening falls
back to it. Review has no deriving signal yet (no linked-PR sync) — manual only.
"""

WORKFLOW_COLUMNS = ("needs_detail", "ready", "in_progress", "review", "blocked", "done")
READY_THRESHOLD = 70


def derive_column(
    *,
    state: str,
    labels: list[dict],
    assignees: list,
    readiness_score: int | None,
    placed_column: str | None,
) -> str:
    if state == "closed":
        return "done"
    if placed_column is not None:
        return placed_column
    if any(str(lb.get("name", "")).lower() == "blocked" for lb in labels):
        return "blocked"
    if assignees:
        return "in_progress"
    if readiness_score is not None and readiness_score >= READY_THRESHOLD:
        return "ready"
    return "needs_detail"
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && uv run pytest tests/test_workflow.py -v`
Expected: 13 PASS

- [ ] **Step 5: Lint and commit**

```bash
cd backend && uv run ruff check .
git add backend/app/workflow.py backend/tests/test_workflow.py
git commit -m "feat: workflow column derivation ladder"
```

---

### Task 3: `GET /repositories/{id}/kanban`

**Model tier:** sonnet (multi-join integration against existing code)

**Files:**
- Create: `backend/app/routers/kanban.py`
- Modify: `backend/app/main.py` (router registration)
- Test: `backend/tests/test_api_kanban.py`

**Interfaces:**
- Consumes: `IssueWorkflow` (Task 1), `derive_column`/`WORKFLOW_COLUMNS` (Task 2), `app.llm.priority.estimate_from(labels, readiness_score) -> int` (existing).
- Produces: JSON `{columns: [{key, cards: [...]}, ...] (always all six, display order), total}`. Card fields: `issue_id, number, title, component, issue_type, priority_band, readiness_pct, estimate, assignees, gh_updated_at, warning, placed`. Tasks 5–7 consume this shape verbatim. Also produces module-level `band_of(urgency, importance)` reused nowhere else yet.

- [ ] **Step 1: Write the failing tests**

Create `backend/tests/test_api_kanban.py`:

```python
from datetime import datetime, timedelta, timezone

import httpx
import pytest

from app.db import get_sessionmaker
from app.main import app
from app.models import (
    Installation,
    Issue,
    IssueClassification,
    IssuePriority,
    IssuePriorityPin,
    IssueReadiness,
    IssueWorkflow,
    Repository,
)

JULY_1 = datetime(2026, 7, 1, tzinfo=timezone.utc)
NOW = datetime.now(timezone.utc)


@pytest.fixture
async def client():
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as c:
        yield c


async def seed(session) -> None:
    session.add(Installation(id=42, account_login="patelmj"))
    await session.flush()
    session.add(
        Repository(id=500, installation_id=42, full_name="patelmj/mehova",
                   owner="patelmj", name="mehova")
    )
    await session.flush()
    common = dict(repository_id=500, body="b", gh_created_at=JULY_1, gh_updated_at=JULY_1)
    session.add(Issue(id=1, number=10, title="Bare", state="open",
                      labels=[], assignees=[], **common))
    session.add(Issue(id=2, number=11, title="Assigned", state="open",
                      labels=[], assignees=["patelmj"], **common))
    session.add(Issue(id=3, number=12, title="Blocked lbl", state="open",
                      labels=[{"name": "Blocked", "color": ""}], assignees=[], **common))
    session.add(Issue(id=4, number=13, title="High readiness", state="open",
                      labels=[{"name": "size/l", "color": ""}], assignees=[], **common))
    session.add(Issue(id=5, number=14, title="Placed review", state="open",
                      labels=[], assignees=["patelmj"], **common))
    session.add(Issue(id=6, number=15, title="Recently closed", state="closed",
                      labels=[], assignees=[], gh_closed_at=NOW - timedelta(days=2), **common))
    session.add(Issue(id=7, number=16, title="Old closed", state="closed",
                      labels=[], assignees=[], gh_closed_at=NOW - timedelta(days=30), **common))
    session.add(Issue(id=8, number=17, title="A PR", state="open",
                      labels=[], assignees=[], is_pull_request=True, **common))
    session.add(Issue(id=9, number=18, title="Placed then closed", state="closed",
                      labels=[], assignees=[], gh_closed_at=NOW - timedelta(days=1), **common))
    await session.flush()
    session.add(IssueClassification(issue_id=4, issue_type="feature", component="api",
                                    confidence=0.9, model="m", issue_gh_updated_at=JULY_1))
    session.add(IssueReadiness(
        issue_id=4, issue_type="feature", score=88, model="m",
        factors=[
            {"requirement": "Clear outcome", "points": 30, "present": True, "evidence": "e"},
            {"requirement": "Acceptance criteria", "points": 25, "present": False, "evidence": ""},
        ],
        issue_gh_updated_at=JULY_1, classification_scored_at=JULY_1))
    session.add(IssuePriority(issue_id=4, urgency=70, importance=60, factors=[],
                              model="m", issue_gh_updated_at=JULY_1))
    session.add(IssuePriority(issue_id=2, urgency=20, importance=30, factors=[],
                              model="m", issue_gh_updated_at=JULY_1))
    session.add(IssuePriorityPin(issue_id=2, pinned_urgency=90, pinned_importance=80))
    session.add(IssueWorkflow(issue_id=5, wf_column="review"))
    session.add(IssueWorkflow(issue_id=9, wf_column="in_progress"))
    await session.commit()


def cards_by_column(data: dict) -> dict[str, list[dict]]:
    return {col["key"]: col["cards"] for col in data["columns"]}


async def test_kanban_grouping_and_derivation(client, clean_db):
    async with get_sessionmaker()() as session:
        await seed(session)

    resp = await client.get("/repositories/500/kanban")
    assert resp.status_code == 200
    data = resp.json()
    cols = cards_by_column(data)
    assert [col["key"] for col in data["columns"]] == [
        "needs_detail", "ready", "in_progress", "review", "blocked", "done",
    ]
    numbers = {key: [c["number"] for c in cards] for key, cards in cols.items()}
    assert numbers["needs_detail"] == [10]
    assert numbers["ready"] == [13]           # readiness 88 ≥ 70, no assignee
    assert numbers["in_progress"] == [11]     # assignee
    assert numbers["review"] == [14]          # manual placement
    assert numbers["blocked"] == [12]         # Blocked label, case-insensitive
    # closed-wins: #18 placed in_progress but closed → done; #16 too old → absent
    assert set(numbers["done"]) == {15, 18}
    assert data["total"] == 7  # PR and old-closed excluded


async def test_kanban_card_payload(client, clean_db):
    async with get_sessionmaker()() as session:
        await seed(session)

    cols = cards_by_column((await client.get("/repositories/500/kanban")).json())
    ready = cols["ready"][0]
    assert ready["component"] == "api"
    assert ready["issue_type"] == "feature"
    assert ready["priority_band"] == "dofirst"      # 70/60
    assert ready["readiness_pct"] == 88
    assert ready["estimate"] == 4                    # size/l label
    assert ready["warning"] == "Acceptance criteria" # first missing factor
    assert ready["placed"] is False
    in_progress = cols["in_progress"][0]
    assert in_progress["priority_band"] == "dofirst"  # pin 90/80 overrides 20/30
    placed = cols["review"][0]
    assert placed["placed"] is True
    assert placed["warning"] is None
    bare = cols["needs_detail"][0]
    assert bare["priority_band"] is None
    assert bare["readiness_pct"] is None


async def test_kanban_sorts_scored_first(client, clean_db):
    async with get_sessionmaker()() as session:
        await seed(session)
        session.add(Issue(id=20, number=30, title="Bare 2", state="open", labels=[],
                          assignees=[], repository_id=500, body="b",
                          gh_created_at=JULY_1, gh_updated_at=JULY_1))
        await session.flush()
        session.add(IssuePriority(issue_id=20, urgency=10, importance=10, factors=[],
                                  model="m", issue_gh_updated_at=JULY_1))
        await session.commit()

    cols = cards_by_column((await client.get("/repositories/500/kanban")).json())
    # scored (#30, sum 20) ranks above unscored (#10) within needs_detail
    assert [c["number"] for c in cols["needs_detail"]] == [30, 10]


async def test_kanban_unknown_repo_404(client, clean_db):
    resp = await client.get("/repositories/999/kanban")
    assert resp.status_code == 404
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend && uv run pytest tests/test_api_kanban.py -v`
Expected: FAIL — 404s (route does not exist)

- [ ] **Step 3: Implement the router**

Create `backend/app/routers/kanban.py`:

```python
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db import get_session
from app.llm.priority import estimate_from
from app.models import (
    Issue,
    IssueClassification,
    IssuePriority,
    IssuePriorityPin,
    IssueReadiness,
    IssueWorkflow,
    Repository,
)
from app.workflow import WORKFLOW_COLUMNS, derive_column

router = APIRouter(tags=["kanban"])

DONE_WINDOW_DAYS = 14


class KanbanCardOut(BaseModel):
    issue_id: int
    number: int
    title: str
    component: str | None
    issue_type: str | None
    priority_band: str | None
    readiness_pct: int | None
    estimate: int
    assignees: list[str]
    gh_updated_at: datetime
    warning: str | None
    placed: bool


class KanbanColumnOut(BaseModel):
    key: str
    cards: list[KanbanCardOut]


class KanbanOut(BaseModel):
    columns: list[KanbanColumnOut]
    total: int


def band_of(urgency: float | None, importance: float | None) -> str | None:
    if urgency is None or importance is None:
        return None
    if urgency >= 50:
        return "dofirst" if importance >= 50 else "delegate"
    return "schedule" if importance >= 50 else "reconsider"


@router.get("/repositories/{repo_id}/kanban", response_model=KanbanOut)
async def repository_kanban(
    repo_id: int, session: AsyncSession = Depends(get_session)
) -> KanbanOut:
    repo = (
        await session.execute(select(Repository).where(Repository.id == repo_id))
    ).scalar_one_or_none()
    if repo is None:
        raise HTTPException(status_code=404, detail="Unknown repository")
    cutoff = datetime.now(timezone.utc) - timedelta(days=DONE_WINDOW_DAYS)
    rows = (
        await session.execute(
            select(
                Issue, IssueWorkflow, IssueClassification, IssueReadiness,
                IssuePriority, IssuePriorityPin,
            )
            .outerjoin(IssueWorkflow, IssueWorkflow.issue_id == Issue.id)
            .outerjoin(IssueClassification, IssueClassification.issue_id == Issue.id)
            .outerjoin(IssueReadiness, IssueReadiness.issue_id == Issue.id)
            .outerjoin(IssuePriority, IssuePriority.issue_id == Issue.id)
            .outerjoin(IssuePriorityPin, IssuePriorityPin.issue_id == Issue.id)
            .where(
                Issue.repository_id == repo_id,
                Issue.is_pull_request.is_(False),
                or_(Issue.state == "open", Issue.gh_closed_at >= cutoff),
            )
        )
    ).all()
    grouped: dict[str, list[tuple[float, int, KanbanCardOut]]] = {
        key: [] for key in WORKFLOW_COLUMNS
    }
    for issue, workflow, classification, readiness, priority, pin in rows:
        readiness_score = readiness.score if readiness else None
        column = derive_column(
            state=issue.state,
            labels=issue.labels or [],
            assignees=issue.assignees or [],
            readiness_score=readiness_score,
            placed_column=workflow.wf_column if workflow else None,
        )
        urgency = pin.pinned_urgency if pin else (priority.urgency if priority else None)
        importance = (
            pin.pinned_importance if pin else (priority.importance if priority else None)
        )
        card = KanbanCardOut(
            issue_id=issue.id,
            number=issue.number,
            title=issue.title,
            component=classification.component if classification else None,
            issue_type=classification.issue_type if classification else None,
            priority_band=band_of(urgency, importance),
            readiness_pct=readiness_score,
            estimate=estimate_from(issue.labels or [], readiness_score),
            assignees=issue.assignees or [],
            gh_updated_at=issue.gh_updated_at,
            warning=next(
                (
                    f["requirement"]
                    for f in (readiness.factors if readiness else [])
                    if not f.get("present")
                ),
                None,
            ),
            placed=workflow is not None,
        )
        rank = (
            -(urgency + importance)
            if urgency is not None and importance is not None
            else 1.0
        )
        grouped[column].append((rank, issue.number, card))
    columns = [
        KanbanColumnOut(
            key=key,
            cards=[card for _, _, card in sorted(grouped[key], key=lambda t: (t[0], t[1]))],
        )
        for key in WORKFLOW_COLUMNS
    ]
    return KanbanOut(columns=columns, total=sum(len(col.cards) for col in columns))
```

- [ ] **Step 4: Register the router**

In `backend/app/main.py` add the import (alphabetical, after `issues`):

```python
from app.routers.kanban import router as kanban_router
```

and after `app.include_router(issues_router)`:

```python
app.include_router(kanban_router)
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd backend && uv run pytest tests/test_api_kanban.py -v`
Expected: 4 PASS

- [ ] **Step 6: Lint, full backend suite, commit**

```bash
cd backend && uv run ruff check . && uv run pytest -q
git add backend/app/routers/kanban.py backend/app/main.py backend/tests/test_api_kanban.py
git commit -m "feat: kanban endpoint with read-time column derivation"
```

---

### Task 4: `PUT`/`DELETE /issues/{id}/workflow`

**Model tier:** sonnet (extends Task 3's file; TDD against existing test file)

**Files:**
- Modify: `backend/app/routers/kanban.py` (append)
- Test: `backend/tests/test_api_kanban.py` (append)

**Interfaces:**
- Consumes: `IssueWorkflow` (Task 1), the GET endpoint (Task 3) for round-trip assertions.
- Produces: `PUT /issues/{id}/workflow` body `{"column": <one of six>}` → `{issue_id, column, placed: true}`; invalid column → 422; unknown issue → 404. `DELETE /issues/{id}/workflow` → 204, idempotent. Tasks 6 e2e stub mirrors these.

- [ ] **Step 1: Write the failing tests**

Append to `backend/tests/test_api_kanban.py`:

```python
async def test_workflow_place_move_and_reset(client, clean_db):
    async with get_sessionmaker()() as session:
        await seed(session)

    resp = await client.put("/issues/1/workflow", json={"column": "ready"})
    assert resp.status_code == 200
    assert resp.json() == {"issue_id": 1, "column": "ready", "placed": True}
    cols = cards_by_column((await client.get("/repositories/500/kanban")).json())
    assert 10 in [c["number"] for c in cols["ready"]]

    resp = await client.put("/issues/1/workflow", json={"column": "blocked"})
    assert resp.status_code == 200
    cols = cards_by_column((await client.get("/repositories/500/kanban")).json())
    assert 10 in [c["number"] for c in cols["blocked"]]

    resp = await client.delete("/issues/1/workflow")
    assert resp.status_code == 204
    resp = await client.delete("/issues/1/workflow")  # idempotent
    assert resp.status_code == 204
    cols = cards_by_column((await client.get("/repositories/500/kanban")).json())
    assert 10 in [c["number"] for c in cols["needs_detail"]]  # back to derived


async def test_workflow_validation(client, clean_db):
    async with get_sessionmaker()() as session:
        await seed(session)
    assert (
        await client.put("/issues/999/workflow", json={"column": "ready"})
    ).status_code == 404
    assert (
        await client.put("/issues/1/workflow", json={"column": "parked"})
    ).status_code == 422
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend && uv run pytest tests/test_api_kanban.py -v`
Expected: the two new tests FAIL with 405/404 (routes missing); Task 3 tests still PASS

- [ ] **Step 3: Implement**

In `backend/app/routers/kanban.py`, extend the imports:

```python
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Response
from sqlalchemy import delete, func, or_, select
from sqlalchemy.dialects.postgresql import insert as pg_insert
```

(keep the other existing imports) and append at the end of the file:

```python
WorkflowColumn = Literal["needs_detail", "ready", "in_progress", "review", "blocked", "done"]


class WorkflowIn(BaseModel):
    column: WorkflowColumn


class WorkflowOut(BaseModel):
    issue_id: int
    column: WorkflowColumn
    placed: bool


@router.put("/issues/{issue_id}/workflow", response_model=WorkflowOut)
async def place_issue(
    issue_id: int, body: WorkflowIn, session: AsyncSession = Depends(get_session)
) -> WorkflowOut:
    issue = (
        await session.execute(select(Issue).where(Issue.id == issue_id))
    ).scalar_one_or_none()
    if issue is None:
        raise HTTPException(status_code=404, detail="Unknown issue")
    values = {"issue_id": issue_id, "wf_column": body.column, "moved_at": func.now()}
    await session.execute(
        pg_insert(IssueWorkflow)
        .values(**values)
        .on_conflict_do_update(
            index_elements=["issue_id"],
            set_={k: v for k, v in values.items() if k != "issue_id"},
        )
    )
    await session.commit()
    return WorkflowOut(issue_id=issue_id, column=body.column, placed=True)


@router.delete("/issues/{issue_id}/workflow", status_code=204)
async def reset_issue_workflow(
    issue_id: int, session: AsyncSession = Depends(get_session)
) -> Response:
    await session.execute(delete(IssueWorkflow).where(IssueWorkflow.issue_id == issue_id))
    await session.commit()
    return Response(status_code=204)
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd backend && uv run pytest tests/test_api_kanban.py -v`
Expected: 6 PASS

- [ ] **Step 5: Lint, full backend suite, commit**

```bash
cd backend && uv run ruff check . && uv run pytest -q
git add backend/app/routers/kanban.py backend/tests/test_api_kanban.py
git commit -m "feat: workflow placement endpoints (put/delete)"
```

---

### Task 5: Board page skeleton — types, static render, navigation

**Model tier:** sonnet (multi-file frontend integration; invoke `Skill("sketch-findings-issuelens")` first)

**Files:**
- Create: `frontend/src/app/plan/board/page.tsx`
- Create: `frontend/src/app/plan/board/board-types.ts`
- Create: `frontend/src/app/plan/board/board-card.tsx`
- Create: `frontend/src/app/plan/board/board-client.tsx`
- Modify: `frontend/src/app/plan/plan-tabs.tsx:6-9` (TABS)
- Modify: `frontend/src/components/sidenav.tsx:15-18` (Plan children)
- Modify: `frontend/e2e/shell.spec.ts:6-9` (nav table)
- Test: `frontend/e2e/board.spec.ts`

**Interfaces:**
- Consumes: `GET /api/backend/repositories/{id}/kanban` (Task 3 shape), `getJson` from `lib/api.ts`, `relativeTime` from `lib/time.ts`, `PlanTabs`.
- Produces: `board-types.ts` exports `WorkflowColumn`, `KanbanCard`, `KanbanPayload`, `COLUMN_ORDER`, `COLUMN_LABEL`, `BAND_LABEL` — Tasks 6–7 import these. `BoardCard` takes `{ card: KanbanCard }` (props widen in Task 6). Column sections carry `data-wf-column={key}` and `data-testid={'col-' + key}`; cards carry `data-testid={'card-' + number}`.

- [ ] **Step 1: Write the failing e2e tests**

Create `frontend/e2e/board.spec.ts`:

```ts
import { expect, test, type Page, type Route } from "@playwright/test";

const COLUMN_KEYS = [
  "needs_detail", "ready", "in_progress", "review", "blocked", "done",
] as const;

const card = (over: Partial<Record<string, unknown>> = {}) => ({
  issue_id: 1,
  number: 42,
  title: "Fix token refresh",
  component: "auth",
  issue_type: "bug",
  priority_band: "dofirst",
  readiness_pct: 80,
  estimate: 3,
  assignees: ["patelmj"],
  gh_updated_at: "2026-07-20T00:00:00Z",
  warning: null,
  placed: false,
  ...over,
});

const CARDS = [
  card(),
  card({
    issue_id: 2, number: 43, title: "Docs typo", component: null,
    issue_type: "docs", priority_band: null, readiness_pct: 40, assignees: [],
    warning: "Acceptance criteria",
  }),
  card({ issue_id: 3, number: 44, title: "Shipped thing", assignees: [] }),
];

const BASE_COLUMN: Record<number, string> = { 1: "in_progress", 2: "needs_detail", 3: "done" };

const repos = [{ id: 500, full_name: "patelmj/mehova" }];

/**
 * Stateful stub: PUT/DELETE mutate `placements`, GET regroups from it —
 * mirrors the real backend so post-mutation refetches never race assertions.
 */
function buildPayload(placements: Record<number, string>) {
  const columns = COLUMN_KEYS.map((key) => ({
    key,
    cards: CARDS.filter(
      (c) => (placements[c.issue_id as number] ?? BASE_COLUMN[c.issue_id as number]) === key,
    ).map((c) => ({ ...c, placed: (c.issue_id as number) in placements })),
  }));
  return { columns, total: CARDS.length };
}

async function stubBoard(
  page: Page,
  calls?: { puts: { issueId: number; body: unknown }[]; deletes: number[] },
) {
  const placements: Record<number, string> = {};
  await page.route(/\/api\/backend\/repositories$/, (route: Route) =>
    route.fulfill({ json: repos }),
  );
  await page.route(/\/api\/backend\/repositories\/500\/kanban$/, (route: Route) =>
    route.fulfill({ json: buildPayload(placements) }),
  );
  await page.route(/\/api\/backend\/issues\/(\d+)\/workflow$/, (route: Route) => {
    const issueId = Number(route.request().url().match(/issues\/(\d+)\/workflow/)![1]);
    if (route.request().method() === "PUT") {
      const body = route.request().postDataJSON() as { column: string };
      calls?.puts.push({ issueId, body });
      placements[issueId] = body.column;
      return route.fulfill({ json: { issue_id: issueId, column: body.column, placed: true } });
    }
    calls?.deletes.push(issueId);
    delete placements[issueId];
    return route.fulfill({ status: 204, body: "" });
  });
}

test("board renders all six columns with derived cards", async ({ page }) => {
  await stubBoard(page);
  await page.goto("/plan/board");
  for (const key of COLUMN_KEYS) {
    await expect(page.getByTestId(`col-${key}`)).toBeVisible();
  }
  await expect(page.getByTestId("col-in_progress")).toContainText("#42");
  await expect(page.getByTestId("col-needs_detail")).toContainText("#43");
  await expect(page.getByTestId("col-done")).toContainText("#44");
  // empty columns stay visible (muted, never hidden)
  await expect(page.getByTestId("col-ready")).toContainText("Ready");
  await expect(page.getByTestId("card-warning-43")).toContainText("Acceptance criteria");
});

test("plan tabs and sidebar navigate to the board", async ({ page }) => {
  await stubBoard(page);
  await page.route(/\/api\/backend\/issues\?/, (route: Route) =>
    route.fulfill({ json: { items: [], total: 0, limit: 50, offset: 0 } }),
  );
  await page.route(/\/api\/backend\/issues\/facets/, (route: Route) =>
    route.fulfill({ json: { labels: [], assignees: [], components: [] } }),
  );
  await page.goto("/plan");
  await page.getByTestId("plan-tabs").getByRole("link", { name: "Board" }).click();
  await expect(page.getByTestId("board-content")).toBeVisible();
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd frontend && npx playwright test e2e/board.spec.ts`
Expected: FAIL (404 page — route does not exist)

- [ ] **Step 3: Create `board-types.ts`**

Create `frontend/src/app/plan/board/board-types.ts`:

```ts
export type WorkflowColumn =
  | "needs_detail"
  | "ready"
  | "in_progress"
  | "review"
  | "blocked"
  | "done";

export type KanbanCard = {
  issue_id: number;
  number: number;
  title: string;
  component: string | null;
  issue_type: string | null;
  priority_band: "dofirst" | "schedule" | "delegate" | "reconsider" | null;
  readiness_pct: number | null;
  estimate: number;
  assignees: string[];
  gh_updated_at: string;
  warning: string | null;
  placed: boolean;
};

export type KanbanColumn = { key: WorkflowColumn; cards: KanbanCard[] };

export type KanbanPayload = { columns: KanbanColumn[]; total: number };

export const COLUMN_ORDER: WorkflowColumn[] = [
  "needs_detail", "ready", "in_progress", "review", "blocked", "done",
];

export const COLUMN_LABEL: Record<WorkflowColumn, string> = {
  needs_detail: "Needs Detail",
  ready: "Ready",
  in_progress: "In Progress",
  review: "Review",
  blocked: "Blocked",
  done: "Done",
};

export const BAND_LABEL: Record<
  NonNullable<KanbanCard["priority_band"]>,
  string
> = {
  dofirst: "Do First",
  schedule: "Schedule",
  delegate: "Delegate",
  reconsider: "Reconsider",
};
```

- [ ] **Step 4: Create `board-card.tsx`**

Create `frontend/src/app/plan/board/board-card.tsx`:

```tsx
"use client";

import { relativeTime } from "../../../lib/time";
import { BAND_LABEL, type KanbanCard } from "./board-types";

export function BoardCard({ card }: { card: KanbanCard }) {
  const meta = [
    card.component,
    card.issue_type,
    card.priority_band ? BAND_LABEL[card.priority_band] : null,
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <article
      data-testid={`card-${card.number}`}
      tabIndex={0}
      className="flex flex-col gap-1 rounded-[10px] border border-(--color-border) bg-(--color-surface) p-2.5 shadow-(--shadow-card)"
    >
      <div className="flex items-start gap-1.5">
        <span className="font-medium text-(--color-text-muted)">#{card.number}</span>
        <span className="grow font-medium">{card.title}</span>
      </div>
      {meta ? (
        <div className="text-[11px] text-(--color-text-muted)">{meta}</div>
      ) : null}
      <div className="text-[11px] text-(--color-text-muted)">
        {card.readiness_pct != null ? `Readiness ${card.readiness_pct}%` : "Unscored"}
        {" · "}Est {card.estimate}
        {card.assignees.length ? ` · ${card.assignees.join(", ")}` : ""}
        {" · "}
        {relativeTime(card.gh_updated_at)}
      </div>
      {card.warning ? (
        <div
          data-testid={`card-warning-${card.number}`}
          className="text-[11px] text-(--pm-other)"
        >
          ⚠ {card.warning}
        </div>
      ) : null}
      {card.placed ? (
        <span
          data-testid={`card-placed-${card.number}`}
          className="self-start rounded-full border border-(--color-border) px-1.5 text-[10px] text-(--color-text-muted)"
        >
          placed
        </span>
      ) : null}
    </article>
  );
}
```

- [ ] **Step 5: Create `board-client.tsx` and `page.tsx`**

Create `frontend/src/app/plan/board/board-client.tsx`:

```tsx
"use client";

import { keepPreviousData, useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { getJson } from "../../../lib/api";
import { PlanTabs } from "../plan-tabs";
import { BoardCard } from "./board-card";
import { COLUMN_LABEL, type KanbanPayload } from "./board-types";

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

  const { data, error, isPending } = useQuery({
    queryKey: kanbanKey,
    queryFn: () => getJson<KanbanPayload>(`/api/backend/repositories/${repoId}/kanban`),
    enabled: repoId != null,
    placeholderData: keepPreviousData,
  });

  const columns = data?.columns ?? [];

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

      <div className="flex items-center gap-2">
        <select
          aria-label="Repository"
          className="rounded-lg border border-(--color-border) bg-(--color-surface) px-2.5 py-1.5"
          value={repoId ?? ""}
          onChange={(e) =>
            router.replace(
              e.target.value ? `/plan/board?repo_id=${e.target.value}` : "/plan/board",
              { scroll: false },
            )
          }
        >
          {(repos ?? []).map((repo) => (
            <option key={repo.id} value={repo.id}>
              {repo.full_name}
            </option>
          ))}
        </select>
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
          <div className="grid min-w-[1080px] grid-cols-6 gap-3">
            {columns.map((col) => (
              <section
                key={col.key}
                data-wf-column={col.key}
                data-testid={`col-${col.key}`}
                className="flex flex-col gap-2"
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
                    <BoardCard key={c.issue_id} card={c} />
                  ))}
                </div>
              </section>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
```

Create `frontend/src/app/plan/board/page.tsx`:

```tsx
import { Suspense } from "react";
import { BoardClient } from "./board-client";

export default function BoardPage() {
  return (
    <Suspense fallback={null}>
      <BoardClient />
    </Suspense>
  );
}
```

- [ ] **Step 6: Wire navigation**

In `frontend/src/app/plan/plan-tabs.tsx` change:

```ts
const TABS = [
  { label: "Table", href: "/plan" },
  { label: "Matrix", href: "/plan/matrix" },
];
```

to:

```ts
const TABS = [
  { label: "Table", href: "/plan" },
  { label: "Matrix", href: "/plan/matrix" },
  { label: "Board", href: "/plan/board" },
];
```

In `frontend/src/components/sidenav.tsx` change the Plan children:

```ts
        children: [
          { label: "Table", href: "/plan" },
          { label: "Matrix", href: "/plan/matrix" },
        ],
```

to:

```ts
        children: [
          { label: "Table", href: "/plan" },
          { label: "Matrix", href: "/plan/matrix" },
          { label: "Board", href: "/plan/board" },
        ],
```

In `frontend/e2e/shell.spec.ts`, after the line
`{ link: "Matrix", href: "/plan/matrix", h1: "Plan" },` add:

```ts
  { link: "Board", href: "/plan/board", h1: "Plan" },
```

- [ ] **Step 7: Run tests to verify they pass**

Run: `cd frontend && npx playwright test e2e/board.spec.ts e2e/shell.spec.ts`
Expected: PASS (board tests + shell nav table including Board)

- [ ] **Step 8: Lint, build, commit**

```bash
cd frontend && npm run lint && npm run build
git add frontend/src/app/plan/board frontend/src/app/plan/plan-tabs.tsx frontend/src/components/sidenav.tsx frontend/e2e/board.spec.ts frontend/e2e/shell.spec.ts
git commit -m "feat: kanban board page with derived columns"
```

---

### Task 6: Drag, card menu, optimistic mutations

**Model tier:** sonnet (interaction logic + Playwright)

**Files:**
- Modify: `frontend/src/app/plan/board/board-types.ts` (append helper)
- Modify: `frontend/src/app/plan/board/board-card.tsx` (full replacement below)
- Modify: `frontend/src/app/plan/board/board-client.tsx` (anchored edits below)
- Test: `frontend/e2e/board.spec.ts` (append)

**Interfaces:**
- Consumes: PUT/DELETE endpoints (Task 4), `sendJson` from `lib/api.ts`.
- Produces: `movedPayload(payload, issueId, to)` in board-types (Task 7 leaves it untouched). `BoardCard` props become `{ card, column, onMove, onReset, onDragTarget }` — exact signature in Step 3.

- [ ] **Step 1: Write the failing e2e tests**

Append to `frontend/e2e/board.spec.ts`:

```ts
test("dragging a card to another column sends PUT and persists", async ({ page }) => {
  const calls = { puts: [] as { issueId: number; body: unknown }[], deletes: [] as number[] };
  await stubBoard(page, calls);
  await page.goto("/plan/board");
  const dragged = page.getByTestId("card-42");
  await expect(dragged).toBeVisible();
  const from = (await dragged.boundingBox())!;
  const target = (await page.getByTestId("col-review").boundingBox())!;
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(target.x + target.width / 2, target.y + 60, { steps: 10 });
  await page.mouse.up();

  await expect.poll(() => calls.puts.length).toBe(1);
  expect(calls.puts[0]).toEqual({ issueId: 1, body: { column: "review" } });
  await expect(page.getByTestId("col-review")).toContainText("#42");
  await expect(page.getByTestId("card-placed-42")).toBeVisible();
});

test("card menu moves and resets placement", async ({ page }) => {
  const calls = { puts: [] as { issueId: number; body: unknown }[], deletes: [] as number[] };
  await stubBoard(page, calls);
  await page.goto("/plan/board");
  await page.getByTestId("card-menu-43").click();
  await page.getByTestId("menu-move-43-ready").click();
  await expect.poll(() => calls.puts.length).toBe(1);
  expect(calls.puts[0]).toEqual({ issueId: 2, body: { column: "ready" } });
  await expect(page.getByTestId("col-ready")).toContainText("#43");

  await page.getByTestId("card-menu-43").click();
  await page.getByTestId("menu-reset-43").click();
  await expect.poll(() => calls.deletes.length).toBe(1);
  await expect(page.getByTestId("col-needs_detail")).toContainText("#43");
  await expect(page.getByTestId("card-placed-43")).not.toBeVisible();
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd frontend && npx playwright test e2e/board.spec.ts`
Expected: the two new tests FAIL (no menu button, drag does nothing); Task 5 tests still PASS

- [ ] **Step 3: Replace `board-card.tsx`**

Full new content of `frontend/src/app/plan/board/board-card.tsx`:

```tsx
"use client";

import { useRef, useState } from "react";
import { relativeTime } from "../../../lib/time";
import {
  BAND_LABEL,
  COLUMN_LABEL,
  COLUMN_ORDER,
  type KanbanCard,
  type WorkflowColumn,
} from "./board-types";

const DRAG_THRESHOLD_PX = 6;

type BoardCardProps = {
  card: KanbanCard;
  column: WorkflowColumn;
  onMove: (issueId: number, to: WorkflowColumn) => void;
  onReset: (issueId: number) => void;
  onDragTarget: (column: WorkflowColumn | null) => void;
};

function columnUnderPointer(x: number, y: number): WorkflowColumn | null {
  const hit = document
    .elementsFromPoint(x, y)
    .find((el): el is HTMLElement => el instanceof HTMLElement && !!el.dataset.wfColumn);
  return (hit?.dataset.wfColumn as WorkflowColumn | undefined) ?? null;
}

export function BoardCard({ card, column, onMove, onReset, onDragTarget }: BoardCardProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [dragging, setDragging] = useState(false);
  const drag = useRef<{ startX: number; startY: number; active: boolean } | null>(null);

  const finishDrag = (commitTo: WorkflowColumn | null) => {
    if (drag.current?.active) {
      if (commitTo && commitTo !== column) onMove(card.issue_id, commitTo);
      setDragging(false);
    }
    drag.current = null;
    onDragTarget(null);
  };

  const meta = [
    card.component,
    card.issue_type,
    card.priority_band ? BAND_LABEL[card.priority_band] : null,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <article
      data-testid={`card-${card.number}`}
      tabIndex={0}
      className={`relative flex touch-none flex-col gap-1 rounded-[10px] border border-(--color-border) bg-(--color-surface) p-2.5 shadow-(--shadow-card) ${
        dragging ? "opacity-60" : ""
      }`}
      onPointerDown={(e) => {
        if (e.button !== 0 || (e.target as HTMLElement).closest("button")) return;
        drag.current = { startX: e.clientX, startY: e.clientY, active: false };
        e.currentTarget.setPointerCapture(e.pointerId);
      }}
      onPointerMove={(e) => {
        const state = drag.current;
        if (!state) return;
        if (!state.active) {
          const moved = Math.hypot(e.clientX - state.startX, e.clientY - state.startY);
          if (moved < DRAG_THRESHOLD_PX) return;
          state.active = true;
          setDragging(true);
        }
        onDragTarget(columnUnderPointer(e.clientX, e.clientY));
      }}
      onPointerUp={(e) => finishDrag(columnUnderPointer(e.clientX, e.clientY))}
      onPointerCancel={() => finishDrag(null)}
    >
      <div className="flex items-start gap-1.5">
        <span className="font-medium text-(--color-text-muted)">#{card.number}</span>
        <span className="grow font-medium">{card.title}</span>
        <button
          type="button"
          data-testid={`card-menu-${card.number}`}
          aria-label={`Actions for #${card.number}`}
          aria-expanded={menuOpen}
          className="rounded px-1 text-(--color-text-muted) transition-all duration-150 hover:bg-(--accent-tint) hover:text-(--color-text)"
          onClick={() => setMenuOpen((open) => !open)}
        >
          ⋯
        </button>
      </div>
      {menuOpen ? (
        <div className="absolute top-8 right-2 z-10 flex w-44 flex-col rounded-[10px] border border-(--color-border) bg-(--color-surface) p-1 shadow-(--shadow-card)">
          {COLUMN_ORDER.filter((key) => key !== column).map((key) => (
            <button
              key={key}
              type="button"
              data-testid={`menu-move-${card.number}-${key}`}
              className="rounded-lg px-2 py-1 text-left transition-all duration-150 hover:bg-(--accent-tint)"
              onClick={() => {
                setMenuOpen(false);
                onMove(card.issue_id, key);
              }}
            >
              Move to {COLUMN_LABEL[key]}
            </button>
          ))}
          {card.placed ? (
            <button
              type="button"
              data-testid={`menu-reset-${card.number}`}
              className="rounded-lg px-2 py-1 text-left text-(--color-primary) transition-all duration-150 hover:bg-(--accent-tint)"
              onClick={() => {
                setMenuOpen(false);
                onReset(card.issue_id);
              }}
            >
              Reset to auto
            </button>
          ) : null}
        </div>
      ) : null}
      {meta ? (
        <div className="text-[11px] text-(--color-text-muted)">{meta}</div>
      ) : null}
      <div className="text-[11px] text-(--color-text-muted)">
        {card.readiness_pct != null ? `Readiness ${card.readiness_pct}%` : "Unscored"}
        {" · "}Est {card.estimate}
        {card.assignees.length ? ` · ${card.assignees.join(", ")}` : ""}
        {" · "}
        {relativeTime(card.gh_updated_at)}
      </div>
      {card.warning ? (
        <div
          data-testid={`card-warning-${card.number}`}
          className="text-[11px] text-(--pm-other)"
        >
          ⚠ {card.warning}
        </div>
      ) : null}
      {card.placed ? (
        <span
          data-testid={`card-placed-${card.number}`}
          className="self-start rounded-full border border-(--color-border) px-1.5 text-[10px] text-(--color-text-muted)"
        >
          placed
        </span>
      ) : null}
    </article>
  );
}
```

- [ ] **Step 4: Add the optimistic-move helper to `board-types.ts`**

Append to `frontend/src/app/plan/board/board-types.ts`:

```ts
/** Optimistically move a card to another column (placed=true, inserted on top). */
export function movedPayload(
  payload: KanbanPayload,
  issueId: number,
  to: WorkflowColumn,
): KanbanPayload {
  let moved: KanbanCard | null = null;
  const stripped = payload.columns.map((col) => {
    const found = col.cards.find((c) => c.issue_id === issueId);
    if (found) moved = { ...found, placed: true };
    return { ...col, cards: col.cards.filter((c) => c.issue_id !== issueId) };
  });
  if (!moved) return payload;
  return {
    ...payload,
    columns: stripped.map((col) =>
      col.key === to ? { ...col, cards: [moved!, ...col.cards] } : col,
    ),
  };
}
```

- [ ] **Step 5: Wire mutations into `board-client.tsx`**

Replace the import block at the top of `frontend/src/app/plan/board/board-client.tsx`:

```tsx
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { getJson } from "../../../lib/api";
import { PlanTabs } from "../plan-tabs";
import { BoardCard } from "./board-card";
import { COLUMN_LABEL, type KanbanPayload } from "./board-types";
```

with:

```tsx
import {
  keepPreviousData,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";
import { getJson, sendJson } from "../../../lib/api";
import { PlanTabs } from "../plan-tabs";
import { BoardCard } from "./board-card";
import {
  COLUMN_LABEL,
  movedPayload,
  type KanbanPayload,
  type WorkflowColumn,
} from "./board-types";
```

Inside `BoardClient`, directly after the `const { data, error, isPending } = useQuery({ ... });` block, insert:

```tsx
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
```

In the repo-select row, after the closing `</select>` tag, insert the error indicator:

```tsx
        {moveError ? (
          <span className="text-(--color-danger)" data-testid="move-error">
            {moveError}
          </span>
        ) : null}
```

Replace the column `<section>` render block:

```tsx
              <section
                key={col.key}
                data-wf-column={col.key}
                data-testid={`col-${col.key}`}
                className="flex flex-col gap-2"
              >
```

with (drop-target highlight):

```tsx
              <section
                key={col.key}
                data-wf-column={col.key}
                data-testid={`col-${col.key}`}
                className={`flex flex-col gap-2 rounded-[10px] transition-all duration-150 ${
                  dropTarget === col.key ? "bg-(--accent-tint)" : ""
                }`}
              >
```

and replace the card render:

```tsx
                  {col.cards.map((c) => (
                    <BoardCard key={c.issue_id} card={c} />
                  ))}
```

with:

```tsx
                  {col.cards.map((c) => (
                    <BoardCard
                      key={c.issue_id}
                      card={c}
                      column={col.key}
                      onMove={(issueId, to) => moveMutation.mutate({ issueId, column: to })}
                      onReset={(issueId) => resetMutation.mutate(issueId)}
                      onDragTarget={setDropTarget}
                    />
                  ))}
```

Note on reset: the optimistic phase intentionally leaves the card where it is
(the client cannot know the derived column); the `onSettled` refetch snaps it
to the server-derived column. The stateful stub makes the e2e deterministic.

- [ ] **Step 6: Run tests to verify they pass**

Run: `cd frontend && npx playwright test e2e/board.spec.ts`
Expected: 4 PASS

- [ ] **Step 7: Lint, build, commit**

```bash
cd frontend && npm run lint && npm run build
git add frontend/src/app/plan/board frontend/e2e/board.spec.ts
git commit -m "feat: kanban drag, card menu, optimistic workflow moves"
```

---

### Task 7: Swimlanes — lane-by Component / Assignee

**Model tier:** sonnet

**Files:**
- Modify: `frontend/src/app/plan/board/board-types.ts` (append)
- Modify: `frontend/src/app/plan/board/board-client.tsx` (anchored edits)
- Test: `frontend/e2e/board.spec.ts` (append)

**Interfaces:**
- Consumes: `KanbanPayload`, `KanbanColumn` (Task 5).
- Produces: `lanesFor(payload, laneBy)` returning `{ lane: string; columns: KanbanColumn[] }[]` — single unnamed lane for `"none"`; fallback lanes (`Unassigned`/`Uncategorized`) sort last.

- [ ] **Step 1: Write the failing e2e test**

Append to `frontend/e2e/board.spec.ts`:

```ts
test("lane-by component groups cards into swimlanes with fallback last", async ({ page }) => {
  await stubBoard(page);
  await page.goto("/plan/board");
  await page.getByTestId("lane-by").getByRole("button", { name: "Component" }).click();
  const lanes = page.getByTestId(/^swimlane-/);
  await expect(lanes).toHaveCount(2);
  await expect(page.getByTestId("swimlane-auth")).toContainText("#42");
  await expect(page.getByTestId("swimlane-auth")).toContainText("#44");
  await expect(page.getByTestId("swimlane-Uncategorized")).toContainText("#43");
  // fallback lane renders last
  await expect(lanes.last()).toHaveAttribute("data-testid", "swimlane-Uncategorized");

  await page.getByTestId("lane-by").getByRole("button", { name: "Assignee" }).click();
  await expect(page.getByTestId("swimlane-patelmj")).toContainText("#42");
  await expect(page.getByTestId("swimlane-Unassigned")).toContainText("#43");

  await page.getByTestId("lane-by").getByRole("button", { name: "None" }).click();
  await expect(page.getByTestId(/^swimlane-/)).toHaveCount(1);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx playwright test e2e/board.spec.ts`
Expected: new test FAILS (no lane-by control); earlier tests PASS

- [ ] **Step 3: Add `lanesFor` to `board-types.ts`**

Append to `frontend/src/app/plan/board/board-types.ts`:

```ts
export type LaneBy = "none" | "component" | "assignee";

export const FALLBACK_LANE: Record<Exclude<LaneBy, "none">, string> = {
  component: "Uncategorized",
  assignee: "Unassigned",
};

function laneKeyOf(card: KanbanCard, laneBy: Exclude<LaneBy, "none">): string {
  if (laneBy === "component") return card.component ?? FALLBACK_LANE.component;
  return card.assignees[0] ?? FALLBACK_LANE.assignee;
}

/** Split the payload into swimlanes; a single unnamed lane when laneBy is "none". */
export function lanesFor(
  payload: KanbanPayload,
  laneBy: LaneBy,
): { lane: string; columns: KanbanColumn[] }[] {
  if (laneBy === "none") return [{ lane: "", columns: payload.columns }];
  const fallback = FALLBACK_LANE[laneBy];
  const names = new Set<string>();
  for (const col of payload.columns) {
    for (const c of col.cards) names.add(laneKeyOf(c, laneBy));
  }
  const ordered = [
    ...[...names].filter((n) => n !== fallback).sort((a, b) => a.localeCompare(b)),
    ...(names.has(fallback) ? [fallback] : []),
  ];
  return ordered.map((lane) => ({
    lane,
    columns: payload.columns.map((col) => ({
      ...col,
      cards: col.cards.filter((c) => laneKeyOf(c, laneBy) === lane),
    })),
  }));
}
```

- [ ] **Step 4: Render lanes in `board-client.tsx`**

Extend the board-types import in `board-client.tsx` to:

```tsx
import {
  COLUMN_LABEL,
  lanesFor,
  movedPayload,
  type KanbanPayload,
  type LaneBy,
  type WorkflowColumn,
} from "./board-types";
```

After the `const [moveError, setMoveError] = useState<string | null>(null);` line, add:

```tsx
  const [laneBy, setLaneBy] = useState<LaneBy>("none");
```

Replace `const columns = data?.columns ?? [];` with:

```tsx
  const lanes = data ? lanesFor(data, laneBy) : [];
```

In the repo-select row, after the `</select>` tag (before the `moveError` span), insert the lane switcher:

```tsx
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
              onClick={() => setLaneBy(value)}
            >
              {label}
            </button>
          ))}
        </div>
```

Replace the board grid block — everything from `<div className="overflow-x-auto pb-2">` through its closing `</div>` — with:

```tsx
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
```

Caveat for the implementer: with lanes active, `data-testid={'col-' + key}` appears once **per lane** — the Task 5/6 tests keep passing because the default lane mode is `none` (single lane). The lane test uses `lane-*` testids for card assertions.

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd frontend && npx playwright test e2e/board.spec.ts`
Expected: 5 PASS

- [ ] **Step 6: Lint, build, full e2e, commit**

```bash
cd frontend && npm run lint && npm run build && npm run test:e2e
git add frontend/src/app/plan/board frontend/e2e/board.spec.ts
git commit -m "feat: kanban swimlanes by component and assignee"
```

---

### Task 8: Full verification + live check

**Model tier:** sonnet (live-verification run); the **final whole-branch review** that follows is dispatched at most-capable per CLAUDE.md.

**Files:** none created — verification only.

- [ ] **Step 1: Full backend suite + lint**

Run: `cd backend && uv run ruff check . && uv run pytest -q`
Expected: all tests pass (164 pre-existing + ~21 new), ruff clean

- [ ] **Step 2: Full frontend lint + build + e2e**

Run: `cd frontend && npm run lint && npm run build && npm run test:e2e`
Expected: lint clean, build succeeds, all e2e pass (25 pre-existing + 5 new).
Gotcha: a stale `issuelens-frontend-1` container on :3005 breaks the Playwright dev-server — `docker compose stop frontend` first if needed.

- [ ] **Step 3: Live verification on dogfood data**

```bash
docker compose up -d --build backend worker frontend
```

(the `migrate` one-shot applies 0008 automatically — verify with
`docker compose logs migrate` showing `Running upgrade 0007 -> 0008`).
Then with Playwright CLI against http://localhost:3005:

1. Open `/plan/board` — six columns render with real issues distributed by the ladder.
2. Drag a card to another column — reload — it stays (placed badge visible).
3. Card menu → Reset to auto — reload — card back in its derived column.
4. Lane by Component and by Assignee — lanes render, fallback lanes last.
5. Close-wins spot check: pick a recently closed issue → appears in Done.

- [ ] **Step 4: Commit any fixes, then stop**

Do NOT open a PR — surface a summary and ask the user first (CLAUDE.md flow).

---

## Follow-up issues to file (via `/todos add`, after plan approval)

1. Kanban: derive Review column from linked PRs (needs PR-link sync) — area `Views & Visualization`, P2, references spec §8.3 "PR: none" line too.
2. Kanban: dependency counts on cards (needs dependency data) — area `Views & Visualization`, P2.
3. Kanban: additional swimlane dimensions (Priority, Milestone, Issue type) — area `Views & Visualization`, P2.
