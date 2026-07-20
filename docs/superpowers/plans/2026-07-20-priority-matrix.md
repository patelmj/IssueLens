# Priority Matrix Implementation Plan (Slice 8, issue #10)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Hybrid urgency/importance scoring pipeline + draggable Eisenhower scatter with execution queue at `/plan/matrix`.

**Architecture:** Mirrors the classify/readiness blueprint: a new arq job (`score_priority_repository`) chained after readiness persists hybrid scores (deterministic signals + bounded Ollama adjustment) into `issue_priority`; manual pins live in `issue_priority_pins` (IssueLens-owned, never synced). A FastAPI router serves the matrix payload and pin mutations. The frontend adds a Table|Matrix segmented control on Plan, an inline-SVG chart with pointer-event drag-to-pin, and an execution queue that takes over the app shell's right rail via a portal slot.

**Tech Stack:** FastAPI + SQLAlchemy async + Alembic + arq + Ollama (httpx), Next.js 16.2.10 + React 19 + TanStack Query 5 + Tailwind v4, Playwright.

**Spec:** `docs/superpowers/specs/2026-07-20-priority-matrix-design.md` (approved).

## Global Constraints

- **Branch:** all work on `feat/priority-matrix` (already exists, holds the spec commit).
- **Commits:** NO author attribution tags, model identifiers, or Co-Authored-By lines. Ever.
- **Tailwind v4:** CSS custom properties use **paren** syntax `bg-(--color-X)` — bracket syntax `bg-[--color-X]` generates empty rules and is forbidden. Same for `text-`, `border-`, `fill-`, etc.
- **Colors:** every color goes through a CSS custom property in `globals.css`. No hardcoded hex/rgba in components.
- **Next.js 16.2.10 has breaking changes vs your training data.** Before writing ANY frontend code, read the relevant guide in `frontend/node_modules/next/dist/docs/` (per `frontend/AGENTS.md`).
- **Backend commands** (run from `backend/`): tests `uv run pytest tests/<file> -v`, lint `uv run ruff check .`, full suite `uv run pytest`.
- **Frontend commands** (run from `frontend/`): lint `npm run lint`, e2e `npx playwright test` (dev server auto-starts on :3005; `reuseExistingServer: true`).
- **Backend tests need local Postgres (issuelens/issuelens@localhost:5432) running** — the conftest creates/migrates `issuelens_test` automatically. Do not point anything at the dev DB.
- Size never encodes importance (it's the y-axis). Bubble radius = `8 + estimate × 2.1`, estimate ∈ 1–5.
- Max 4 categorical series on the scatter: `bug`, `feature`, `debt`, everything else folds to `other`.
- Closed issues and PRs are NEVER scored or returned by the matrix endpoint.
- Widen greps: when a task says "update call sites", grep for ALL of them; do not trust any enumerated list.

---

### Task 1: Models + migration 0007 + test-DB truncate list

**Files:**
- Modify: `backend/app/models.py` (append after `IssueSuggestion`, before `SyncJob`)
- Create: `backend/alembic/versions/0007_issue_priority.py`
- Modify: `backend/tests/conftest.py:71` (TRUNCATE list)
- Test: `backend/tests/test_models_priority.py`

**Interfaces:**
- Produces: ORM classes `IssuePriority` (issue_id PK, urgency int, importance int, factors JSONB list, model text, scored_at tz, issue_gh_updated_at tz) and `IssuePriorityPin` (issue_id PK, pinned_urgency float, pinned_importance float, created_at tz) importable from `app.models`. All later backend tasks consume these.

- [ ] **Step 1: Write the failing test**

`backend/tests/test_models_priority.py`:

```python
from datetime import datetime, timezone

from sqlalchemy import select

from app.db import get_sessionmaker
from app.models import (
    Installation,
    Issue,
    IssuePriority,
    IssuePriorityPin,
    Repository,
)

JULY_1 = datetime(2026, 7, 1, tzinfo=timezone.utc)


async def _seed_issue(session) -> None:
    session.add(Installation(id=42, account_login="patelmj"))
    await session.flush()
    session.add(
        Repository(
            id=500,
            installation_id=42,
            full_name="patelmj/mehova",
            owner="patelmj",
            name="mehova",
        )
    )
    await session.flush()
    session.add(
        Issue(
            id=9001,
            repository_id=500,
            number=42,
            title="Fix token refresh",
            body="crash",
            state="open",
            labels=[],
            assignees=[],
            gh_created_at=JULY_1,
            gh_updated_at=JULY_1,
        )
    )
    await session.flush()


async def test_priority_and_pin_round_trip(clean_db):
    async with get_sessionmaker()() as session:
        await _seed_issue(session)
        session.add(
            IssuePriority(
                issue_id=9001,
                urgency=84,
                importance=76,
                factors=[
                    {
                        "axis": "urgency",
                        "sign": "+",
                        "text": "Priority P0 set",
                        "source": "signal",
                        "weight": 30,
                    }
                ],
                model="test-model",
                issue_gh_updated_at=JULY_1,
            )
        )
        session.add(
            IssuePriorityPin(issue_id=9001, pinned_urgency=91.5, pinned_importance=12.25)
        )
        await session.commit()

    async with get_sessionmaker()() as session:
        priority = (
            await session.execute(select(IssuePriority).where(IssuePriority.issue_id == 9001))
        ).scalar_one()
        pin = (
            await session.execute(
                select(IssuePriorityPin).where(IssuePriorityPin.issue_id == 9001)
            )
        ).scalar_one()
    assert priority.urgency == 84
    assert priority.factors[0]["source"] == "signal"
    assert priority.scored_at is not None
    assert pin.pinned_urgency == 91.5


async def test_deleting_issue_cascades_priority_rows(clean_db):
    async with get_sessionmaker()() as session:
        await _seed_issue(session)
        session.add(
            IssuePriority(
                issue_id=9001, urgency=50, importance=50, factors=[],
                model="test-model", issue_gh_updated_at=JULY_1,
            )
        )
        session.add(IssuePriorityPin(issue_id=9001, pinned_urgency=1, pinned_importance=1))
        await session.commit()
        issue = (await session.execute(select(Issue).where(Issue.id == 9001))).scalar_one()
        await session.delete(issue)
        await session.commit()

    async with get_sessionmaker()() as session:
        assert (await session.execute(select(IssuePriority))).first() is None
        assert (await session.execute(select(IssuePriorityPin))).first() is None
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && uv run pytest tests/test_models_priority.py -v`
Expected: FAIL — `ImportError: cannot import name 'IssuePriority'`

- [ ] **Step 3: Add the models**

Append to `backend/app/models.py` (after `IssueSuggestion`, before `SyncJob`):

```python
class IssuePriority(Base):
    __tablename__ = "issue_priority"

    issue_id: Mapped[int] = mapped_column(
        BigInteger, ForeignKey("issues.id", ondelete="CASCADE"), primary_key=True
    )
    urgency: Mapped[int] = mapped_column(Integer)
    importance: Mapped[int] = mapped_column(Integer)
    factors: Mapped[list] = mapped_column(JSONB, default=list)
    model: Mapped[str] = mapped_column(Text)
    scored_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
    issue_gh_updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))


class IssuePriorityPin(Base):
    __tablename__ = "issue_priority_pins"

    issue_id: Mapped[int] = mapped_column(
        BigInteger, ForeignKey("issues.id", ondelete="CASCADE"), primary_key=True
    )
    pinned_urgency: Mapped[float] = mapped_column(Double)
    pinned_importance: Mapped[float] = mapped_column(Double)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
```

- [ ] **Step 4: Add migration**

`backend/alembic/versions/0007_issue_priority.py`:

```python
"""issue priority + pins"""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import JSONB

revision = "0007"
down_revision = "0006"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "issue_priority",
        sa.Column(
            "issue_id",
            sa.BigInteger(),
            sa.ForeignKey("issues.id", ondelete="CASCADE"),
            primary_key=True,
        ),
        sa.Column("urgency", sa.Integer(), nullable=False),
        sa.Column("importance", sa.Integer(), nullable=False),
        sa.Column("factors", JSONB(), nullable=False),
        sa.Column("model", sa.Text(), nullable=False),
        sa.Column(
            "scored_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column("issue_gh_updated_at", sa.DateTime(timezone=True), nullable=False),
    )
    op.create_table(
        "issue_priority_pins",
        sa.Column(
            "issue_id",
            sa.BigInteger(),
            sa.ForeignKey("issues.id", ondelete="CASCADE"),
            primary_key=True,
        ),
        sa.Column("pinned_urgency", sa.Double(), nullable=False),
        sa.Column("pinned_importance", sa.Double(), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
    )


def downgrade() -> None:
    op.drop_table("issue_priority_pins")
    op.drop_table("issue_priority")
```

- [ ] **Step 5: Update the clean_db TRUNCATE list**

In `backend/tests/conftest.py`, the `clean_db` fixture truncate statement becomes:

```python
            text(
                "TRUNCATE installations, repositories, issues, issue_classifications, "
                "issue_readiness, issue_priority, issue_priority_pins, sync_jobs "
                "RESTART IDENTITY CASCADE"
            )
```

(Grep `backend/tests` for any OTHER hardcoded TRUNCATE lists and update them all.)

- [ ] **Step 6: Run test to verify it passes**

Run: `cd backend && uv run pytest tests/test_models_priority.py -v`
Expected: 2 PASS (session fixture migrates the test DB to head, picking up 0007)

- [ ] **Step 7: Run full backend suite + lint (regression check)**

Run: `cd backend && uv run pytest -q && uv run ruff check .`
Expected: all pass

- [ ] **Step 8: Commit**

```bash
git add backend/app/models.py backend/alembic/versions/0007_issue_priority.py backend/tests/conftest.py backend/tests/test_models_priority.py
git commit -m "feat: issue_priority and issue_priority_pins tables"
```

---

### Task 2: Deterministic priority signals (pure functions)

**Files:**
- Create: `backend/app/llm/priority.py`
- Test: `backend/tests/test_priority_signals.py`

**Interfaces:**
- Produces (consumed by Tasks 4 & 6):
  - `compute_signal_scores(*, labels: list[dict], milestone_title: str | None, comments_count: int, gh_created_at: datetime, gh_updated_at: datetime, component: str | None, readiness_score: int | None, now: datetime) -> SignalScores` where `SignalScores` is a frozen dataclass with `urgency: int`, `importance: int`, `factors: list[dict]`
  - `estimate_from(labels: list[dict], readiness_score: int | None) -> int` (1–5)
  - `priority_label(labels: list[dict]) -> str | None` (`"P0"|"P1"|"P2"|None`)
  - Factor dict shape (used everywhere downstream): `{"axis": "urgency"|"importance", "sign": "+"|"-", "text": str, "source": "signal"|"llm", "weight": int}`

- [ ] **Step 1: Write the failing tests**

`backend/tests/test_priority_signals.py`:

```python
from datetime import datetime, timezone

from app.llm.priority import compute_signal_scores, estimate_from, priority_label

NOW = datetime(2026, 7, 20, tzinfo=timezone.utc)


def label(name: str) -> dict:
    return {"name": name, "color": "d73a4a"}


def base_kwargs(**over):
    kwargs = dict(
        labels=[],
        milestone_title=None,
        comments_count=0,
        gh_created_at=datetime(2026, 7, 18, tzinfo=timezone.utc),
        gh_updated_at=datetime(2026, 7, 19, tzinfo=timezone.utc),
        component=None,
        readiness_score=None,
        now=NOW,
    )
    kwargs.update(over)
    return kwargs


def test_priority_label_detection():
    assert priority_label([label("P0")]) == "P0"
    assert priority_label([label("p1")]) == "P1"
    assert priority_label([label("bug"), label("P2")]) == "P2"
    assert priority_label([label("bug")]) is None


def test_bare_fresh_issue_gets_base_scores_and_no_milestone_penalty():
    result = compute_signal_scores(**base_kwargs())
    # urgency: 30 base - 8 no milestone = 22; importance: 30 base
    assert result.urgency == 22
    assert result.importance == 30
    texts = [f["text"] for f in result.factors]
    assert any("No milestone" in t for t in texts)
    assert all(f["source"] == "signal" for f in result.factors)


def test_p0_label_boosts_both_axes():
    result = compute_signal_scores(**base_kwargs(labels=[label("P0")]))
    # urgency: 30 + 30 (P0) - 8 (no milestone) = 52
    assert result.urgency == 52
    # importance: 30 + 35 (P0) = 65
    assert result.importance == 65
    assert any(f["text"] == "Priority P0 set" and f["axis"] == "urgency" for f in result.factors)


def test_aged_p0_gains_age_urgency():
    result = compute_signal_scores(
        **base_kwargs(
            labels=[label("P0")],
            gh_created_at=datetime(2026, 7, 5, tzinfo=timezone.utc),  # 15 days old
        )
    )
    # urgency: 30 + 30 (P0) + 15 (P0 older than 7d) - 8 = 67
    assert result.urgency == 67


def test_milestone_and_activity_boost_urgency():
    result = compute_signal_scores(
        **base_kwargs(milestone_title="v2.0", comments_count=5)
    )
    # urgency: 30 + 12 (milestone) + 10 (active discussion, updated 1d ago) = 52
    assert result.urgency == 52
    assert any("milestone" in f["text"].lower() for f in result.factors)


def test_stale_issue_loses_urgency():
    result = compute_signal_scores(
        **base_kwargs(
            gh_created_at=datetime(2026, 1, 1, tzinfo=timezone.utc),
            gh_updated_at=datetime(2026, 4, 1, tzinfo=timezone.utc),  # 110 days
        )
    )
    # urgency: 30 + 5 (unlabeled older than 180d? no: 200d created — yes) ...
    # created 2026-01-01 = 200 days before NOW → +5 stale-backlog
    # updated 110 days ago → -10 staleness; no milestone → -8
    assert result.urgency == 30 + 5 - 10 - 8
    assert any("No updates" in f["text"] for f in result.factors)


def test_critical_component_and_impact_labels_boost_importance():
    result = compute_signal_scores(
        **base_kwargs(labels=[label("regression"), label("security")], component="auth")
    )
    # importance: 30 + 15 (auth critical) + 15 (security) + 12 (regression) = 72
    assert result.importance == 72


def test_docs_component_reduces_importance():
    result = compute_signal_scores(**base_kwargs(component="docs"))
    assert result.importance == 20


def test_high_readiness_adds_importance():
    result = compute_signal_scores(**base_kwargs(readiness_score=88))
    assert result.importance == 35
    assert any("readiness" in f["text"].lower() for f in result.factors)


def test_scores_clamped_to_0_100():
    result = compute_signal_scores(
        **base_kwargs(
            labels=[label("P0"), label("security"), label("regression"), label("customer")],
            milestone_title="v2.0",
            comments_count=10,
            component="auth",
            readiness_score=90,
            gh_created_at=datetime(2026, 6, 1, tzinfo=timezone.utc),
        )
    )
    assert 0 <= result.urgency <= 100
    assert 0 <= result.importance <= 100


def test_estimate_from_size_labels():
    assert estimate_from([label("size/XS")], None) == 1
    assert estimate_from([label("size/s")], None) == 2
    assert estimate_from([label("size/M")], None) == 3
    assert estimate_from([label("size/l")], None) == 4
    assert estimate_from([label("size/XL")], None) == 5


def test_estimate_from_readiness_gap():
    assert estimate_from([], 100) == 1   # gap 0 → round 0 → clamped to 1
    assert estimate_from([], 50) == 3    # gap 50/20 = 2.5 → round 2 (banker's) → but int math: see impl
    assert estimate_from([], 0) == 5
    assert estimate_from([], None) == 3
```

**Note on `test_estimate_from_readiness_gap`:** Python `round(2.5)` is 2 (banker's rounding). The implementation must avoid that trap — use `int((gap + 10) // 20)` style arithmetic. With the implementation below: gap 50 → `min(5, max(1, (50 + 10) // 20))` = 3. The assertions above match the implementation in Step 3; keep them as written.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend && uv run pytest tests/test_priority_signals.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'app.llm.priority'`

- [ ] **Step 3: Implement `backend/app/llm/priority.py`**

```python
import logging
from dataclasses import dataclass
from datetime import datetime

logger = logging.getLogger(__name__)

URGENCY_BASE = 30
IMPORTANCE_BASE = 30

PRIORITY_URGENCY = {"P0": 30, "P1": 18, "P2": 8}
PRIORITY_IMPORTANCE = {"P0": 35, "P1": 20, "P2": 8}
# priority label -> (age threshold in days, urgency bonus once exceeded)
AGE_URGENCY = {"P0": (7, 15), "P1": (30, 10), "P2": (90, 5), None: (180, 5)}
MILESTONE_URGENCY = 12
NO_MILESTONE_PENALTY = 8
ACTIVE_DISCUSSION_URGENCY = 10
ACTIVE_DISCUSSION_MAX_DAYS = 7
ACTIVE_DISCUSSION_MIN_COMMENTS = 3
STALE_UPDATE_DAYS = 60
STALE_UPDATE_PENALTY = 10

CRITICAL_COMPONENTS = {"auth", "api", "security", "infra", "infrastructure", "database", "db", "core"}
CRITICAL_COMPONENT_IMPORTANCE = 15
LOW_STAKE_COMPONENTS = {"docs", "documentation"}
LOW_STAKE_PENALTY = 10
IMPACT_LABELS = {"security": 15, "regression": 12, "customer": 12}
READY_IMPORTANCE = 5
READY_THRESHOLD = 75

SIZE_LABELS = {"size/xs": 1, "size/s": 2, "size/m": 3, "size/l": 4, "size/xl": 5}
DEFAULT_ESTIMATE = 3


@dataclass(frozen=True)
class SignalScores:
    urgency: int
    importance: int
    factors: list


def _clamp(value: float, low: int = 0, high: int = 100) -> int:
    return int(max(low, min(high, value)))


def _factor(axis: str, sign: str, text: str, weight: int) -> dict:
    return {"axis": axis, "sign": sign, "text": text, "source": "signal", "weight": weight}


def _label_names(labels: list[dict]) -> set[str]:
    return {str(lb.get("name", "")).lower() for lb in labels}


def priority_label(labels: list[dict]) -> str | None:
    names = {str(lb.get("name", "")).upper() for lb in labels}
    for level in ("P0", "P1", "P2"):
        if level in names:
            return level
    return None


def estimate_from(labels: list[dict], readiness_score: int | None) -> int:
    names = _label_names(labels)
    for name, estimate in SIZE_LABELS.items():
        if name in names:
            return estimate
    if readiness_score is not None:
        gap = 100 - readiness_score
        return _clamp((gap + 10) // 20, low=1, high=5)
    return DEFAULT_ESTIMATE


def compute_signal_scores(
    *,
    labels: list[dict],
    milestone_title: str | None,
    comments_count: int,
    gh_created_at: datetime,
    gh_updated_at: datetime,
    component: str | None,
    readiness_score: int | None,
    now: datetime,
) -> SignalScores:
    factors: list[dict] = []
    urgency = float(URGENCY_BASE)
    importance = float(IMPORTANCE_BASE)
    plabel = priority_label(labels)
    age_days = max(0, (now - gh_created_at).days)
    updated_days = max(0, (now - gh_updated_at).days)

    if plabel is not None:
        weight = PRIORITY_URGENCY[plabel]
        urgency += weight
        factors.append(_factor("urgency", "+", f"Priority {plabel} set", weight))

    age_threshold, age_weight = AGE_URGENCY[plabel]
    if age_days > age_threshold:
        urgency += age_weight
        level = plabel or "no"
        factors.append(
            _factor("urgency", "+", f"Open {age_days} days at {level} priority", age_weight)
        )

    if milestone_title:
        urgency += MILESTONE_URGENCY
        factors.append(
            _factor("urgency", "+", f"Assigned to milestone {milestone_title}", MILESTONE_URGENCY)
        )
    else:
        urgency -= NO_MILESTONE_PENALTY
        factors.append(
            _factor("urgency", "-", "No milestone (urgency uncertain)", NO_MILESTONE_PENALTY)
        )

    if (
        updated_days <= ACTIVE_DISCUSSION_MAX_DAYS
        and comments_count >= ACTIVE_DISCUSSION_MIN_COMMENTS
    ):
        urgency += ACTIVE_DISCUSSION_URGENCY
        factors.append(
            _factor(
                "urgency",
                "+",
                f"Active discussion ({comments_count} comments)",
                ACTIVE_DISCUSSION_URGENCY,
            )
        )

    if updated_days > STALE_UPDATE_DAYS:
        urgency -= STALE_UPDATE_PENALTY
        factors.append(
            _factor("urgency", "-", f"No updates in {updated_days} days", STALE_UPDATE_PENALTY)
        )

    if plabel is not None:
        weight = PRIORITY_IMPORTANCE[plabel]
        importance += weight
        factors.append(_factor("importance", "+", f"Priority {plabel} set", weight))

    if component:
        normalized = component.strip().lower()
        if normalized in CRITICAL_COMPONENTS:
            importance += CRITICAL_COMPONENT_IMPORTANCE
            factors.append(
                _factor(
                    "importance",
                    "+",
                    f"{normalized} is a critical component",
                    CRITICAL_COMPONENT_IMPORTANCE,
                )
            )
        elif normalized in LOW_STAKE_COMPONENTS:
            importance -= LOW_STAKE_PENALTY
            factors.append(
                _factor("importance", "-", "Documentation-scoped change", LOW_STAKE_PENALTY)
            )

    names = _label_names(labels)
    for label_name, weight in IMPACT_LABELS.items():
        if label_name in names:
            importance += weight
            factors.append(
                _factor("importance", "+", f"Labeled {label_name}", weight)
            )

    if readiness_score is not None and readiness_score >= READY_THRESHOLD:
        importance += READY_IMPORTANCE
        factors.append(
            _factor(
                "importance",
                "+",
                f"Ready to work (readiness {readiness_score}%)",
                READY_IMPORTANCE,
            )
        )

    return SignalScores(
        urgency=_clamp(urgency), importance=_clamp(importance), factors=factors
    )
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd backend && uv run pytest tests/test_priority_signals.py -v`
Expected: all PASS. If a boundary assertion fails, fix the TEST only if the implementation matches this plan exactly; otherwise fix the implementation.

- [ ] **Step 5: Lint and commit**

```bash
cd backend && uv run ruff check .
git add backend/app/llm/priority.py backend/tests/test_priority_signals.py
git commit -m "feat: deterministic urgency/importance signal scoring"
```

---

### Task 3: Ollama priority assessment

**Files:**
- Modify: `backend/app/llm/ollama.py` (append at end)
- Test: `backend/tests/test_ollama_priority.py`

**Interfaces:**
- Consumes: `make_ollama_client`, `get_settings` (existing).
- Produces (consumed by Task 4): `assess_priority(client: httpx.AsyncClient, prompt: str) -> dict` returning `{"urgency_adjustment": int (±25), "importance_adjustment": int (±25), "factors": list[dict]}` with factor dicts `{"axis", "sign", "text", "source": "llm", "weight": 0}`; `PriorityError` exception; `MAX_PRIORITY_ADJUSTMENT = 25`.

- [ ] **Step 1: Write the failing tests**

`backend/tests/test_ollama_priority.py` (mirror the respx style of `tests/test_ollama.py` — read that file first for the `BASE` constant and client fixture idiom):

```python
import json

import pytest
import respx

from app.llm.ollama import PriorityError, assess_priority, make_ollama_client

BASE = "http://127.0.0.1:11434"


def chat_response(payload: dict) -> dict:
    return {"message": {"content": json.dumps(payload)}}


@respx.mock(base_url=BASE)
async def test_assess_priority_normalizes_result(respx_mock):
    respx_mock.post("/api/chat").respond(
        json=chat_response(
            {
                "urgency_adjustment": 18,
                "importance_adjustment": -7,
                "factors": [
                    {"axis": "urgency", "sign": "+", "text": "Customer reports login broken"},
                ],
            }
        )
    )
    async with make_ollama_client() as client:
        result = await assess_priority(client, "prompt")
    assert result["urgency_adjustment"] == 18
    assert result["importance_adjustment"] == -7
    assert result["factors"] == [
        {
            "axis": "urgency",
            "sign": "+",
            "text": "Customer reports login broken",
            "source": "llm",
            "weight": 0,
        }
    ]


@respx.mock(base_url=BASE)
async def test_assess_priority_clamps_adjustments(respx_mock):
    respx_mock.post("/api/chat").respond(
        json=chat_response(
            {"urgency_adjustment": 90, "importance_adjustment": -90, "factors": []}
        )
    )
    async with make_ollama_client() as client:
        result = await assess_priority(client, "prompt")
    assert result["urgency_adjustment"] == 25
    assert result["importance_adjustment"] == -25


@respx.mock(base_url=BASE)
async def test_assess_priority_drops_malformed_factors_and_caps_count(respx_mock):
    factors = [{"axis": "importance", "sign": "-", "text": f"reason {i}"} for i in range(9)]
    factors.insert(0, "not-a-dict")
    factors.insert(1, {"axis": "nope", "sign": "+", "text": "bad axis"})
    respx_mock.post("/api/chat").respond(
        json=chat_response(
            {"urgency_adjustment": 0, "importance_adjustment": 0, "factors": factors}
        )
    )
    async with make_ollama_client() as client:
        result = await assess_priority(client, "prompt")
    assert len(result["factors"]) == 6
    assert all(f["axis"] == "importance" for f in result["factors"])


@respx.mock(base_url=BASE)
async def test_assess_priority_rejects_non_json(respx_mock):
    respx_mock.post("/api/chat").respond(json={"message": {"content": "not json"}})
    async with make_ollama_client() as client:
        with pytest.raises(PriorityError):
            await assess_priority(client, "prompt")


@respx.mock(base_url=BASE)
async def test_assess_priority_rejects_missing_adjustments(respx_mock):
    respx_mock.post("/api/chat").respond(json=chat_response({"factors": []}))
    async with make_ollama_client() as client:
        with pytest.raises(PriorityError):
            await assess_priority(client, "prompt")
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend && uv run pytest tests/test_ollama_priority.py -v`
Expected: FAIL — `ImportError: cannot import name 'PriorityError'`

- [ ] **Step 3: Append to `backend/app/llm/ollama.py`**

```python
MAX_PRIORITY_ADJUSTMENT = 25
MAX_PRIORITY_FACTORS = 6
MAX_FACTOR_TEXT_LENGTH = 200
FACTOR_AXES = ("urgency", "importance")
FACTOR_SIGNS = ("+", "-")


class PriorityError(Exception):
    """The model returned output we could not use for priority assessment."""


PRIORITY_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "urgency_adjustment": {"type": "integer"},
        "importance_adjustment": {"type": "integer"},
        "factors": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "axis": {"type": "string", "enum": list(FACTOR_AXES)},
                    "sign": {"type": "string", "enum": list(FACTOR_SIGNS)},
                    "text": {"type": "string"},
                },
                "required": ["axis", "sign", "text"],
            },
        },
    },
    "required": ["urgency_adjustment", "importance_adjustment", "factors"],
}


def _clamp_adjustment(raw: Any, field: str) -> int:
    try:
        value = int(raw)
    except (TypeError, ValueError) as exc:
        raise PriorityError(f"invalid {field}: {raw!r}") from exc
    return max(-MAX_PRIORITY_ADJUSTMENT, min(MAX_PRIORITY_ADJUSTMENT, value))


def _normalize_priority(raw: Any) -> dict[str, Any]:
    if not isinstance(raw, dict):
        raise PriorityError(f"expected object, got {type(raw).__name__}")
    if "urgency_adjustment" not in raw or "importance_adjustment" not in raw:
        raise PriorityError("missing adjustment fields")
    factors = []
    for item in raw.get("factors") or []:
        if not isinstance(item, dict):
            continue
        axis = item.get("axis")
        sign = item.get("sign")
        text = item.get("text")
        if axis not in FACTOR_AXES or sign not in FACTOR_SIGNS or not isinstance(text, str):
            continue
        text = text.strip()[:MAX_FACTOR_TEXT_LENGTH]
        if not text:
            continue
        factors.append({"axis": axis, "sign": sign, "text": text, "source": "llm", "weight": 0})
        if len(factors) >= MAX_PRIORITY_FACTORS:
            break
    return {
        "urgency_adjustment": _clamp_adjustment(raw["urgency_adjustment"], "urgency_adjustment"),
        "importance_adjustment": _clamp_adjustment(
            raw["importance_adjustment"], "importance_adjustment"
        ),
        "factors": factors,
    }


async def assess_priority(client: httpx.AsyncClient, prompt: str) -> dict[str, Any]:
    resp = await client.post(
        "/api/chat",
        json={
            "model": get_settings().ollama_model,
            "messages": [{"role": "user", "content": prompt}],
            "stream": False,
            "think": False,
            "format": PRIORITY_SCHEMA,
            "options": {"temperature": 0},
        },
    )
    resp.raise_for_status()
    content = resp.json()["message"]["content"]
    try:
        raw = json.loads(content)
    except json.JSONDecodeError as exc:
        raise PriorityError(f"model returned non-JSON: {content[:200]!r}") from exc
    return _normalize_priority(raw)
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd backend && uv run pytest tests/test_ollama_priority.py -v`
Expected: all PASS

- [ ] **Step 5: Lint and commit**

```bash
cd backend && uv run ruff check .
git add backend/app/llm/ollama.py backend/tests/test_ollama_priority.py
git commit -m "feat: ollama priority assessment with bounded adjustments"
```

---

### Task 4: Priority scoring job body (staleness query + combiner + upsert)

**Files:**
- Modify: `backend/app/llm/priority.py` (append)
- Test: `backend/tests/test_priority_worker.py`

**Interfaces:**
- Consumes: Task 2's `compute_signal_scores`; Task 3's `assess_priority`/`PriorityError`; `ensure_model` from `app.llm.ollama`; models from Task 1; `MAX_BODY_CHARS` from `app.llm.readiness`.
- Produces (consumed by Task 5): `score_repository_priorities(session: AsyncSession, client: httpx.AsyncClient, repo_id: int) -> int` and `stale_priority_query(repo_id: int) -> Select`. SyncJob `kind="priority"`. On per-issue LLM failure the issue is STILL persisted with `model="heuristic-only"` (this deliberately differs from readiness, which skips).

- [ ] **Step 1: Write the failing tests**

`backend/tests/test_priority_worker.py`:

```python
from datetime import datetime, timedelta, timezone

import respx
from sqlalchemy import select

from app.db import get_sessionmaker
from app.llm.ollama import make_ollama_client
from app.llm.priority import score_repository_priorities
from app.models import (
    Installation,
    Issue,
    IssueClassification,
    IssuePriority,
    IssuePriorityPin,
    IssueReadiness,
    Repository,
    SyncJob,
)

BASE = "http://127.0.0.1:11434"
# Relative to wall clock: the job scores with datetime.now(), so fixed dates would
# make these tests decay. 10-day-old, updated 5 days ago, P1, 0 comments →
# urgency = 30 + 18 (P1) - 8 (no milestone) = 40; no age bonus (10 < 30), no
# activity bonus, no staleness.
NOW = datetime.now(timezone.utc)
CREATED_AT = NOW - timedelta(days=10)
UPDATED_AT = NOW - timedelta(days=5)

TAGS = {"models": [{"name": "test-model"}]}
ASSESSMENT = {
    "message": {
        "content": '{"urgency_adjustment": 10, "importance_adjustment": 5, '
        '"factors": [{"axis": "urgency", "sign": "+", "text": "Regression stated"}]}'
    }
}


async def seed_repo(session) -> None:
    session.add(Installation(id=42, account_login="patelmj"))
    await session.flush()
    session.add(
        Repository(id=500, installation_id=42, full_name="patelmj/mehova",
                   owner="patelmj", name="mehova")
    )
    await session.flush()


def make_issue(issue_id: int, number: int, **over) -> Issue:
    fields = dict(
        id=issue_id, repository_id=500, number=number, title=f"Issue {number}",
        body="body", state="open", labels=[{"name": "P1", "color": ""}],
        assignees=[], gh_created_at=CREATED_AT, gh_updated_at=UPDATED_AT,
    )
    fields.update(over)
    return Issue(**fields)


@respx.mock(base_url=BASE, assert_all_called=False)
async def test_scores_open_issues_and_merges_llm_factors(respx_mock, clean_db):
    respx_mock.get("/api/tags").respond(json=TAGS)
    respx_mock.post("/api/chat").respond(json=ASSESSMENT)
    async with get_sessionmaker()() as session:
        await seed_repo(session)
        session.add(make_issue(9001, 42))
        session.add(make_issue(9002, 43, state="closed"))
        session.add(make_issue(9003, 44, is_pull_request=True))
        await session.commit()

    async with get_sessionmaker()() as session, make_ollama_client() as client:
        count = await score_repository_priorities(session, client, 500)

    assert count == 1
    async with get_sessionmaker()() as session:
        rows = list((await session.execute(select(IssuePriority))).scalars())
        job = (
            await session.execute(select(SyncJob).where(SyncJob.kind == "priority"))
        ).scalar_one()
    assert [r.issue_id for r in rows] == [9001]
    row = rows[0]
    assert row.model == "test-model"
    sources = {f["source"] for f in row.factors}
    assert sources == {"signal", "llm"}
    # P1 base urgency: 30+18-8(no milestone)=40, +10 llm = 50 (0 comments: no activity bonus)
    assert row.urgency == 50
    assert job.status == "success"
    assert job.issues_upserted == 1


@respx.mock(base_url=BASE, assert_all_called=False)
async def test_unchanged_issue_not_rescored(respx_mock, clean_db):
    respx_mock.get("/api/tags").respond(json=TAGS)
    respx_mock.post("/api/chat").respond(json=ASSESSMENT)
    async with get_sessionmaker()() as session:
        await seed_repo(session)
        session.add(make_issue(9001, 42))
        await session.commit()

    async with get_sessionmaker()() as session, make_ollama_client() as client:
        assert await score_repository_priorities(session, client, 500) == 1
    async with get_sessionmaker()() as session, make_ollama_client() as client:
        assert await score_repository_priorities(session, client, 500) == 0


@respx.mock(base_url=BASE, assert_all_called=False)
async def test_newer_classification_triggers_rescore(respx_mock, clean_db):
    respx_mock.get("/api/tags").respond(json=TAGS)
    respx_mock.post("/api/chat").respond(json=ASSESSMENT)
    async with get_sessionmaker()() as session:
        await seed_repo(session)
        session.add(make_issue(9001, 42))
        await session.commit()
    async with get_sessionmaker()() as session, make_ollama_client() as client:
        assert await score_repository_priorities(session, client, 500) == 1

    async with get_sessionmaker()() as session:
        session.add(
            IssueClassification(
                issue_id=9001, issue_type="bug", component="auth", confidence=0.9,
                model="test-model", issue_gh_updated_at=UPDATED_AT,
            )
        )
        await session.commit()

    async with get_sessionmaker()() as session, make_ollama_client() as client:
        assert await score_repository_priorities(session, client, 500) == 1
    async with get_sessionmaker()() as session:
        row = (await session.execute(select(IssuePriority))).scalar_one()
    assert any("critical component" in f["text"] for f in row.factors)


@respx.mock(base_url=BASE, assert_all_called=False)
async def test_ollama_down_persists_heuristic_only(respx_mock, clean_db):
    respx_mock.get("/api/tags").respond(status_code=503)
    async with get_sessionmaker()() as session:
        await seed_repo(session)
        session.add(make_issue(9001, 42))
        await session.commit()

    async with get_sessionmaker()() as session, make_ollama_client() as client:
        count = await score_repository_priorities(session, client, 500)

    assert count == 1
    async with get_sessionmaker()() as session:
        row = (await session.execute(select(IssuePriority))).scalar_one()
    assert row.model == "heuristic-only"
    assert all(f["source"] == "signal" for f in row.factors)
    assert row.urgency == 40  # 30+18-8, no llm adjustment


@respx.mock(base_url=BASE, assert_all_called=False)
async def test_rescore_never_touches_pins(respx_mock, clean_db):
    respx_mock.get("/api/tags").respond(json=TAGS)
    respx_mock.post("/api/chat").respond(json=ASSESSMENT)
    async with get_sessionmaker()() as session:
        await seed_repo(session)
        session.add(make_issue(9001, 42))
        session.add(IssuePriorityPin(issue_id=9001, pinned_urgency=95, pinned_importance=95))
        await session.commit()

    async with get_sessionmaker()() as session, make_ollama_client() as client:
        await score_repository_priorities(session, client, 500)

    async with get_sessionmaker()() as session:
        pin = (await session.execute(select(IssuePriorityPin))).scalar_one()
    assert pin.pinned_urgency == 95
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend && uv run pytest tests/test_priority_worker.py -v`
Expected: FAIL — `ImportError: cannot import name 'score_repository_priorities'`

- [ ] **Step 3: Append to `backend/app/llm/priority.py`**

Add these imports at the top of the file (merge with existing):

```python
from datetime import datetime, timezone

import httpx
from sqlalchemy import Select, func, select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import get_settings
from app.llm.ollama import PriorityError, assess_priority, ensure_model
from app.llm.readiness import MAX_BODY_CHARS
from app.models import (
    Issue,
    IssueClassification,
    IssuePriority,
    IssueReadiness,
    Repository,
    SyncJob,
)
```

Append after `compute_signal_scores`:

```python
HEURISTIC_ONLY_MODEL = "heuristic-only"

PRIORITY_PROMPT_TEMPLATE = """You are assessing the urgency and importance of a GitHub \
issue for prioritization on an Eisenhower matrix.

Repository: {repo_full_name}
Issue title: {title}
Issue body:
{body}

Judge ONLY what the issue text actually states; do not assume missing information.

Return:
- "urgency_adjustment": integer -25..25. Positive when the text states time pressure: a \
regression, a customer or user blocked right now, a deadline, or work blocking other work. \
Negative when the text says it can wait (nice-to-have, someday, exploratory).
- "importance_adjustment": integer -25..25. Positive when the text states high impact: many \
users affected, data loss, security exposure, revenue or trust at stake, core functionality \
broken. Negative when impact is explicitly cosmetic, an edge case, or affects few users.
- "factors": up to 4 short statements (max 15 words each) justifying the adjustments, each \
tagged with the axis it affects ("urgency" or "importance") and its direction ("+" or "-").
"""


def build_priority_prompt(repo_full_name: str, issue: Issue) -> str:
    return PRIORITY_PROMPT_TEMPLATE.format(
        repo_full_name=repo_full_name,
        title=issue.title,
        body=(issue.body or "")[:MAX_BODY_CHARS] or "(empty)",
    )


def stale_priority_query(repo_id: int) -> Select:
    """Open issues with no priority row, a newer update, or fresher upstream analysis."""
    return (
        select(Issue, IssueClassification, IssueReadiness)
        .outerjoin(IssueClassification, IssueClassification.issue_id == Issue.id)
        .outerjoin(IssueReadiness, IssueReadiness.issue_id == Issue.id)
        .outerjoin(IssuePriority, IssuePriority.issue_id == Issue.id)
        .where(
            Issue.repository_id == repo_id,
            Issue.is_pull_request.is_(False),
            Issue.state == "open",
            IssuePriority.issue_id.is_(None)
            | (Issue.gh_updated_at > IssuePriority.issue_gh_updated_at)
            | (IssueClassification.classified_at > IssuePriority.scored_at)
            | (IssueReadiness.scored_at > IssuePriority.scored_at),
        )
        .order_by(Issue.id)
    )


def _clamp_score(value: int) -> int:
    return max(0, min(100, value))


async def score_repository_priorities(
    session: AsyncSession, client: httpx.AsyncClient, repo_id: int
) -> int:
    repo = (
        await session.execute(select(Repository).where(Repository.id == repo_id))
    ).scalar_one()
    job = SyncJob(repository_id=repo_id, kind="priority", status="running")
    session.add(job)
    await session.commit()
    job_id = job.id
    try:
        llm_ready = True
        try:
            await ensure_model(client)
        except httpx.HTTPError:
            llm_ready = False
            logger.exception("ollama unavailable; scoring repo %s heuristic-only", repo_id)
        rows = list((await session.execute(stale_priority_query(repo_id))).all())
        now = datetime.now(timezone.utc)
        scored = 0
        for issue, classification, readiness in rows:
            signals = compute_signal_scores(
                labels=issue.labels or [],
                milestone_title=issue.milestone_title,
                comments_count=issue.comments_count,
                gh_created_at=issue.gh_created_at,
                gh_updated_at=issue.gh_updated_at,
                component=classification.component if classification else None,
                readiness_score=readiness.score if readiness else None,
                now=now,
            )
            urgency, importance = signals.urgency, signals.importance
            factors = list(signals.factors)
            model = HEURISTIC_ONLY_MODEL
            if llm_ready:
                try:
                    assessment = await assess_priority(
                        client, build_priority_prompt(repo.full_name, issue)
                    )
                except (httpx.HTTPError, PriorityError):
                    logger.exception(
                        "priority assessment failed for issue %s in repo %s",
                        issue.id,
                        repo_id,
                    )
                else:
                    urgency = _clamp_score(urgency + assessment["urgency_adjustment"])
                    importance = _clamp_score(
                        importance + assessment["importance_adjustment"]
                    )
                    factors.extend(assessment["factors"])
                    model = get_settings().ollama_model
            values = {
                "issue_id": issue.id,
                "urgency": urgency,
                "importance": importance,
                "factors": factors,
                "model": model,
                "scored_at": func.now(),
                "issue_gh_updated_at": issue.gh_updated_at,
            }
            await session.execute(
                pg_insert(IssuePriority)
                .values(**values)
                .on_conflict_do_update(
                    index_elements=["issue_id"],
                    set_={k: v for k, v in values.items() if k != "issue_id"},
                )
            )
            await session.commit()
            scored += 1
        job.status = "success"
        job.issues_upserted = scored
        job.finished_at = func.now()
        await session.commit()
        return scored
    except Exception as exc:
        await session.rollback()
        job = (
            await session.execute(select(SyncJob).where(SyncJob.id == job_id))
        ).scalar_one()
        job.status = "error"
        job.error = str(exc)[:500]
        job.finished_at = func.now()
        await session.commit()
        raise
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd backend && uv run pytest tests/test_priority_worker.py -v`
Expected: all PASS

- [ ] **Step 5: Lint, full backend suite, commit**

```bash
cd backend && uv run ruff check . && uv run pytest -q
git add backend/app/llm/priority.py backend/tests/test_priority_worker.py
git commit -m "feat: hybrid priority scoring job with heuristic-only fallback"
```

---

### Task 5: Worker wiring (chain + cron + registration)

**Files:**
- Modify: `backend/worker.py`
- Test: `backend/tests/test_worker_priority.py`

**Interfaces:**
- Consumes: Task 4's `score_repository_priorities`.
- Produces: arq job `score_priority_repository(ctx, repo_id)`; `score_readiness_repository` now enqueues it with `_job_id=f"priority-{repo_id}"`; cron `priority_all_repositories` at minutes {25, 55}.

- [ ] **Step 1: Write the failing tests**

`backend/tests/test_worker_priority.py`:

```python
import worker


class FakeRedis:
    def __init__(self):
        self.calls = []

    async def enqueue_job(self, *args, **kwargs):
        self.calls.append((args, kwargs))
        return object()


async def test_readiness_job_enqueues_priority(monkeypatch):
    async def fake_score(session, client, repo_id):
        return 3

    monkeypatch.setattr(worker, "score_repository_issues", fake_score)
    redis = FakeRedis()

    result = await worker.score_readiness_repository({"redis": redis}, 500)

    assert result == 3
    assert redis.calls == [
        (("score_priority_repository", 500), {"_job_id": "priority-500"})
    ]


async def test_readiness_failure_does_not_enqueue_priority(monkeypatch):
    async def failing(session, client, repo_id):
        raise RuntimeError("boom")

    monkeypatch.setattr(worker, "score_repository_issues", failing)
    redis = FakeRedis()
    try:
        await worker.score_readiness_repository({"redis": redis}, 500)
    except RuntimeError:
        pass
    else:
        raise AssertionError("expected RuntimeError")
    assert redis.calls == []


async def test_priority_job_calls_scorer(monkeypatch):
    seen = {}

    async def fake_score(session, client, repo_id):
        seen["repo_id"] = repo_id
        return 5

    monkeypatch.setattr(worker, "score_repository_priorities", fake_score)

    result = await worker.score_priority_repository({}, 500)

    assert result == 5
    assert seen["repo_id"] == 500


def test_worker_registers_priority_jobs():
    names = {getattr(fn, "name", None) or fn.__name__ for fn in worker.WorkerSettings.functions}
    assert "score_priority_repository" in names
    cron_names = {job.name for job in worker.WorkerSettings.cron_jobs}
    assert "priority_all_repositories" in cron_names
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend && uv run pytest tests/test_worker_priority.py -v`
Expected: FAIL — `AttributeError: module 'worker' has no attribute 'score_priority_repository'` (and the enqueue assertion fails)

- [ ] **Step 3: Wire the worker**

In `backend/worker.py`:

1. Add to imports: `from app.llm.priority import score_repository_priorities`
2. Replace the existing `score_readiness_repository` function with:

```python
async def score_readiness_repository(ctx: dict, repo_id: int) -> int:
    async with get_sessionmaker()() as session, make_ollama_client() as client:
        count = await score_repository_issues(session, client, repo_id)
    redis = ctx.get("redis")
    if redis is not None:
        await redis.enqueue_job(
            "score_priority_repository", repo_id, _job_id=f"priority-{repo_id}"
        )
    return count
```

3. Add after it:

```python
async def score_priority_repository(ctx: dict, repo_id: int) -> int:
    async with get_sessionmaker()() as session, make_ollama_client() as client:
        return await score_repository_priorities(session, client, repo_id)


async def priority_all_repositories(ctx: dict) -> int:
    """Safety net for issues readiness-scored while the worker was down; dedupe-keyed."""
    from sqlalchemy import select

    from app.models import Repository

    async with get_sessionmaker()() as session:
        repo_ids = list((await session.execute(select(Repository.id))).scalars())
    done = 0
    for repo_id in repo_ids:
        try:
            await ctx["redis"].enqueue_job(
                "score_priority_repository", repo_id, _job_id=f"priority-{repo_id}"
            )
            done += 1
        except Exception:
            logger.exception("priority sweep failed for repo %s", repo_id)
    return done
```

4. In `WorkerSettings`: add `score_priority_repository` to `functions`, and add to `cron_jobs`:

```python
        cron(priority_all_repositories, name="priority_all_repositories", minute={25, 55}),
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd backend && uv run pytest tests/test_worker_priority.py tests/test_worker_jobs.py tests/test_readiness_worker.py -v`
Expected: all PASS. **If any existing readiness-worker test asserts `score_readiness_repository` enqueues nothing, update that test** — the chain now continues to priority. Grep `backend/tests` for `score_readiness_repository` to find ALL affected tests.

- [ ] **Step 5: Lint, full suite, commit**

```bash
cd backend && uv run ruff check . && uv run pytest -q
git add backend/worker.py backend/tests/test_worker_priority.py backend/tests
git commit -m "feat: chain priority scoring into worker with cron sweep"
```

---

### Task 6: Priority API router

**Files:**
- Create: `backend/app/routers/priority.py`
- Modify: `backend/app/main.py` (import + include_router)
- Test: `backend/tests/test_api_priority.py`

**Interfaces:**
- Consumes: models (Task 1), `estimate_from` (Task 2).
- Produces (consumed by frontend Tasks 8–11):
  - `GET /repositories/{repo_id}/priority` → `{"items": [MatrixItemOut], "total": int, "scored": int, "unscored": int}` where `MatrixItemOut` = `{issue_id, number, title, urgency: int|null, importance: int|null, factors: list, issue_type: str|null, component: str|null, readiness_score: int|null, labels: list, assignees: list, estimate: int, pinned: bool, pinned_urgency: float|null, pinned_importance: float|null, scored_at: datetime|null, model: str|null}`. 404 for unknown repo. Only open, non-PR issues. Ordered by `number` asc.
  - `PUT /issues/{issue_id}/pin` body `{"urgency": float 0-100, "importance": float 0-100}` → `{"issue_id", "pinned": true, "pinned_urgency", "pinned_importance"}`; 404 unknown issue; 422 out-of-range (FastAPI validation).
  - `DELETE /issues/{issue_id}/pin` → 204, idempotent.

- [ ] **Step 1: Write the failing tests**

`backend/tests/test_api_priority.py` (mirror the httpx `ASGITransport` idiom used by `tests/test_api_issues.py` — read that file first and reuse its client fixture pattern exactly):

```python
from datetime import datetime, timezone

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
    Repository,
)

JULY_1 = datetime(2026, 7, 1, tzinfo=timezone.utc)


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
    common = dict(
        repository_id=500, body="b", assignees=["patelmj"],
        gh_created_at=JULY_1, gh_updated_at=JULY_1,
    )
    session.add(Issue(id=1, number=10, title="Scored + pinned", state="open",
                      labels=[{"name": "size/l", "color": ""}], **common))
    session.add(Issue(id=2, number=11, title="Unscored", state="open", labels=[], **common))
    session.add(Issue(id=3, number=12, title="Closed", state="closed", labels=[], **common))
    session.add(Issue(id=4, number=13, title="A PR", state="open", labels=[],
                      is_pull_request=True, **common))
    await session.flush()
    session.add(IssueClassification(issue_id=1, issue_type="bug", component="auth",
                                    confidence=0.9, model="m", issue_gh_updated_at=JULY_1))
    session.add(IssueReadiness(issue_id=1, issue_type="bug", score=80, factors=[],
                               model="m", issue_gh_updated_at=JULY_1,
                               classification_scored_at=JULY_1))
    session.add(IssuePriority(issue_id=1, urgency=70, importance=60,
                              factors=[{"axis": "urgency", "sign": "+", "text": "t",
                                        "source": "signal", "weight": 5}],
                              model="m", issue_gh_updated_at=JULY_1))
    session.add(IssuePriorityPin(issue_id=1, pinned_urgency=90.5, pinned_importance=20))
    await session.commit()


async def test_matrix_payload(client, clean_db):
    async with get_sessionmaker()() as session:
        await seed(session)

    resp = await client.get("/repositories/500/priority")
    assert resp.status_code == 200
    data = resp.json()
    assert data["total"] == 2
    assert data["scored"] == 1
    assert data["unscored"] == 1
    by_number = {item["number"]: item for item in data["items"]}
    assert set(by_number) == {10, 11}
    scored = by_number[10]
    assert scored["urgency"] == 70
    assert scored["pinned"] is True
    assert scored["pinned_urgency"] == 90.5
    assert scored["estimate"] == 4  # size/l label
    assert scored["issue_type"] == "bug"
    assert scored["readiness_score"] == 80
    assert scored["factors"][0]["source"] == "signal"
    unscored = by_number[11]
    assert unscored["urgency"] is None
    assert unscored["pinned"] is False
    assert unscored["estimate"] == 3  # no labels, no readiness → default


async def test_matrix_unknown_repo_404(client, clean_db):
    resp = await client.get("/repositories/999/priority")
    assert resp.status_code == 404


async def test_pin_upsert_and_release(client, clean_db):
    async with get_sessionmaker()() as session:
        await seed(session)

    resp = await client.put("/issues/2/pin", json={"urgency": 33.5, "importance": 66})
    assert resp.status_code == 200
    assert resp.json() == {
        "issue_id": 2, "pinned": True, "pinned_urgency": 33.5, "pinned_importance": 66.0,
    }
    resp = await client.put("/issues/2/pin", json={"urgency": 40, "importance": 66})
    assert resp.status_code == 200
    assert resp.json()["pinned_urgency"] == 40.0

    matrix = (await client.get("/repositories/500/priority")).json()
    item = next(i for i in matrix["items"] if i["issue_id"] == 2)
    assert item["pinned"] is True and item["pinned_urgency"] == 40.0

    resp = await client.delete("/issues/2/pin")
    assert resp.status_code == 204
    resp = await client.delete("/issues/2/pin")  # idempotent
    assert resp.status_code == 204
    matrix = (await client.get("/repositories/500/priority")).json()
    item = next(i for i in matrix["items"] if i["issue_id"] == 2)
    assert item["pinned"] is False


async def test_pin_validation(client, clean_db):
    async with get_sessionmaker()() as session:
        await seed(session)
    assert (await client.put("/issues/999/pin", json={"urgency": 1, "importance": 1})).status_code == 404
    assert (await client.put("/issues/2/pin", json={"urgency": 101, "importance": 1})).status_code == 422
    assert (await client.put("/issues/2/pin", json={"urgency": -1, "importance": 1})).status_code == 422
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend && uv run pytest tests/test_api_priority.py -v`
Expected: FAIL — 404s everywhere (router not registered)

- [ ] **Step 3: Implement `backend/app/routers/priority.py`**

```python
from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException, Response
from pydantic import BaseModel, Field
from sqlalchemy import delete, select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.db import get_session
from app.llm.priority import estimate_from
from app.models import (
    Issue,
    IssueClassification,
    IssuePriority,
    IssuePriorityPin,
    IssueReadiness,
    Repository,
)

router = APIRouter(tags=["priority"])


class MatrixItemOut(BaseModel):
    issue_id: int
    number: int
    title: str
    urgency: int | None
    importance: int | None
    factors: list[dict]
    issue_type: str | None
    component: str | None
    readiness_score: int | None
    labels: list[dict]
    assignees: list[str]
    estimate: int
    pinned: bool
    pinned_urgency: float | None
    pinned_importance: float | None
    scored_at: datetime | None
    model: str | None


class MatrixOut(BaseModel):
    items: list[MatrixItemOut]
    total: int
    scored: int
    unscored: int


@router.get("/repositories/{repo_id}/priority", response_model=MatrixOut)
async def repository_matrix(
    repo_id: int, session: AsyncSession = Depends(get_session)
) -> MatrixOut:
    repo = (
        await session.execute(select(Repository).where(Repository.id == repo_id))
    ).scalar_one_or_none()
    if repo is None:
        raise HTTPException(status_code=404, detail="Unknown repository")
    rows = (
        await session.execute(
            select(Issue, IssuePriority, IssuePriorityPin, IssueClassification, IssueReadiness)
            .outerjoin(IssuePriority, IssuePriority.issue_id == Issue.id)
            .outerjoin(IssuePriorityPin, IssuePriorityPin.issue_id == Issue.id)
            .outerjoin(IssueClassification, IssueClassification.issue_id == Issue.id)
            .outerjoin(IssueReadiness, IssueReadiness.issue_id == Issue.id)
            .where(
                Issue.repository_id == repo_id,
                Issue.is_pull_request.is_(False),
                Issue.state == "open",
            )
            .order_by(Issue.number)
        )
    ).all()
    items = [
        MatrixItemOut(
            issue_id=issue.id,
            number=issue.number,
            title=issue.title,
            urgency=priority.urgency if priority else None,
            importance=priority.importance if priority else None,
            factors=priority.factors if priority else [],
            issue_type=classification.issue_type if classification else None,
            component=classification.component if classification else None,
            readiness_score=readiness.score if readiness else None,
            labels=issue.labels,
            assignees=issue.assignees,
            estimate=estimate_from(issue.labels or [], readiness.score if readiness else None),
            pinned=pin is not None,
            pinned_urgency=pin.pinned_urgency if pin else None,
            pinned_importance=pin.pinned_importance if pin else None,
            scored_at=priority.scored_at if priority else None,
            model=priority.model if priority else None,
        )
        for issue, priority, pin, classification, readiness in rows
    ]
    scored = sum(1 for item in items if item.urgency is not None)
    return MatrixOut(items=items, total=len(items), scored=scored, unscored=len(items) - scored)


class PinIn(BaseModel):
    urgency: float = Field(ge=0, le=100)
    importance: float = Field(ge=0, le=100)


class PinOut(BaseModel):
    issue_id: int
    pinned: bool
    pinned_urgency: float
    pinned_importance: float


@router.put("/issues/{issue_id}/pin", response_model=PinOut)
async def pin_issue(
    issue_id: int, body: PinIn, session: AsyncSession = Depends(get_session)
) -> PinOut:
    issue = (
        await session.execute(select(Issue).where(Issue.id == issue_id))
    ).scalar_one_or_none()
    if issue is None:
        raise HTTPException(status_code=404, detail="Unknown issue")
    values = {
        "issue_id": issue_id,
        "pinned_urgency": body.urgency,
        "pinned_importance": body.importance,
    }
    await session.execute(
        pg_insert(IssuePriorityPin)
        .values(**values)
        .on_conflict_do_update(
            index_elements=["issue_id"],
            set_={k: v for k, v in values.items() if k != "issue_id"},
        )
    )
    await session.commit()
    return PinOut(
        issue_id=issue_id,
        pinned=True,
        pinned_urgency=body.urgency,
        pinned_importance=body.importance,
    )


@router.delete("/issues/{issue_id}/pin", status_code=204)
async def release_pin(issue_id: int, session: AsyncSession = Depends(get_session)) -> Response:
    await session.execute(
        delete(IssuePriorityPin).where(IssuePriorityPin.issue_id == issue_id)
    )
    await session.commit()
    return Response(status_code=204)
```

- [ ] **Step 4: Register the router in `backend/app/main.py`**

Add `from app.routers.priority import router as priority_router` to the imports and `app.include_router(priority_router)` after the existing `include_router` calls.

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd backend && uv run pytest tests/test_api_priority.py -v`
Expected: all PASS

- [ ] **Step 6: Lint, full suite, commit**

```bash
cd backend && uv run ruff check . && uv run pytest -q
git add backend/app/routers/priority.py backend/app/main.py backend/tests/test_api_priority.py
git commit -m "feat: priority matrix API with pin upsert and release"
```

---

### Task 7: Frontend foundation — PUT support, matrix tokens, right-rail slot, Plan tabs

> Before touching any file: read the routing + layout docs in `frontend/node_modules/next/dist/docs/`.

**Files:**
- Modify: `frontend/src/lib/api.ts` (widen `sendJson` method union)
- Modify: `frontend/src/app/globals.css` (append matrix tokens + rowflash keyframes)
- Create: `frontend/src/components/right-rail.tsx`
- Modify: `frontend/src/app/providers.tsx` (wrap with `RightRailProvider`)
- Modify: `frontend/src/components/app-shell.tsx` (aside → `RightRailSlot` with current card as fallback)
- Create: `frontend/src/app/plan/plan-tabs.tsx`
- Modify: `frontend/src/app/plan/plan-client.tsx` (add `<PlanTabs />` to the title row)

**Interfaces:**
- Produces: `sendJson(url, "PUT", body)`; CSS vars `--pm-bug`, `--pm-feature`, `--pm-debt`, `--pm-other`, `--quad-schedule`, `--quad-dofirst`, `--quad-delegate`, `--quad-reconsider`, `--pin-ring`; `.qrow-flash` animation class; `<RightRail>` (portal into shell aside), `<RightRailSlot fallback={...}>`; `<PlanTabs />` (Table|Matrix segmented control).

- [ ] **Step 1: Widen `sendJson`**

In `frontend/src/lib/api.ts` change the method union to:

```ts
  method: "POST" | "PUT" | "PATCH" | "DELETE",
```

- [ ] **Step 2: Append matrix tokens to `frontend/src/app/globals.css`**

Add inside the existing `:root` block (light values — dataviz-validated palette):

```css
  --pm-bug: #2a78d6;
  --pm-feature: #008300;
  --pm-debt: #e87ba4;
  --pm-other: #eda100;
  --quad-schedule: rgba(42, 120, 214, 0.05);
  --quad-dofirst: rgba(209, 36, 47, 0.05);
  --quad-delegate: rgba(27, 124, 131, 0.05);
  --quad-reconsider: rgba(110, 112, 118, 0.05);
  --pin-ring: #17181c;
```

Add inside the existing `:root[data-mode="dark"]` block:

```css
  --pm-bug: #3987e5;
  --pm-feature: #008300;
  --pm-debt: #d55181;
  --pm-other: #c98500;
  --quad-schedule: rgba(57, 135, 229, 0.1);
  --quad-dofirst: rgba(244, 112, 103, 0.1);
  --quad-delegate: rgba(57, 197, 207, 0.1);
  --quad-reconsider: rgba(150, 152, 161, 0.1);
  --pin-ring: #ededf0;
```

Append at the end of the file:

```css
.qrow-flash {
  animation: rowflash 1.2s ease;
}
@keyframes rowflash {
  0% {
    background: var(--flash);
  }
  100% {
    background: transparent;
  }
}
```

- [ ] **Step 3: Create `frontend/src/components/right-rail.tsx`**

A portal-based slot so a page can take over the shell's right rail. Boolean-only context — passing ReactNode through state would re-render forever.

```tsx
"use client";

import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";

const SLOT_ID = "right-rail-slot";

const RailContext = createContext<{
  active: boolean;
  setActive: (value: boolean) => void;
} | null>(null);

export function RightRailProvider({ children }: { children: ReactNode }) {
  const [active, setActive] = useState(false);
  return (
    <RailContext.Provider value={{ active, setActive }}>
      {children}
    </RailContext.Provider>
  );
}

/** Rendered by the app shell. Shows `fallback` until a page mounts a <RightRail>. */
export function RightRailSlot({ fallback }: { fallback: ReactNode }) {
  const rail = useContext(RailContext);
  return (
    <>
      <div id={SLOT_ID} />
      {rail?.active ? null : fallback}
    </>
  );
}

/** Rendered by a page; portals its children into the shell's right rail. */
export function RightRail({ children }: { children: ReactNode }) {
  const rail = useContext(RailContext);
  const setActive = rail?.setActive;
  const [target, setTarget] = useState<Element | null>(null);
  useEffect(() => {
    setTarget(document.getElementById(SLOT_ID));
    setActive?.(true);
    return () => setActive?.(false);
  }, [setActive]);
  return target ? createPortal(children, target) : null;
}
```

- [ ] **Step 4: Wire provider and slot**

`frontend/src/app/providers.tsx` — wrap the query provider's children:

```tsx
"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState } from "react";
import { RightRailProvider } from "../components/right-rail";

export function Providers({ children }: { children: React.ReactNode }) {
  const [queryClient] = useState(() => new QueryClient());
  return (
    <QueryClientProvider client={queryClient}>
      <RightRailProvider>{children}</RightRailProvider>
    </QueryClientProvider>
  );
}
```

`frontend/src/components/app-shell.tsx` — replace the `<aside>` contents:

```tsx
import { Header } from "./header";
import { RightRailSlot } from "./right-rail";
import { Sidenav } from "./sidenav";

export function AppShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col">
      <Header />
      <div className="grid grow grid-cols-[216px_minmax(0,1fr)_330px] gap-5 p-5">
        <Sidenav />
        <main className="min-w-0">{children}</main>
        <aside>
          <RightRailSlot
            fallback={
              <div className="rounded-[14px] border border-(--color-border) bg-(--color-surface) p-4 text-(--color-text-muted) shadow-(--shadow-card)">
                <div className="pb-1 text-[10px] font-semibold tracking-[0.08em] uppercase">
                  Context
                </div>
                Details about your selection will appear here once data is
                connected.
              </div>
            }
          />
        </aside>
      </div>
    </div>
  );
}
```

- [ ] **Step 5: Create `frontend/src/app/plan/plan-tabs.tsx`**

```tsx
"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const TABS = [
  { label: "Table", href: "/plan" },
  { label: "Matrix", href: "/plan/matrix" },
];

export function PlanTabs() {
  const pathname = usePathname();
  return (
    <div
      className="flex items-center gap-0.5 rounded-[9px] border border-(--color-border) bg-(--color-surface) p-0.5"
      data-testid="plan-tabs"
    >
      {TABS.map(({ label, href }) => (
        <Link
          key={href}
          href={href}
          aria-current={pathname === href ? "page" : undefined}
          className={`rounded-[7px] px-2.5 py-1 transition-all duration-150 ${
            pathname === href
              ? "bg-(--accent-tint) font-medium text-(--color-primary)"
              : "text-(--color-text-muted) hover:text-(--color-text)"
          }`}
        >
          {label}
        </Link>
      ))}
    </div>
  );
}
```

- [ ] **Step 6: Add tabs to the Plan title row**

In `frontend/src/app/plan/plan-client.tsx`, import `PlanTabs` and change the title row to:

```tsx
      <div className="flex items-baseline gap-3">
        <h1 className="text-lg font-semibold tracking-[-0.01em]">Plan</h1>
        <span className="text-(--color-text-muted)">
          Issues across your synced repositories
        </span>
        <div className="grow" />
        <PlanTabs />
      </div>
```

- [ ] **Step 7: Lint + existing e2e regression**

Run: `cd frontend && npm run lint && npx playwright test`
Expected: lint clean; all existing e2e specs still pass (shell/overview/plan/triage unaffected — the fallback rail renders identically).

- [ ] **Step 8: Commit**

```bash
git add frontend/src/lib/api.ts frontend/src/app/globals.css frontend/src/components/right-rail.tsx frontend/src/app/providers.tsx frontend/src/components/app-shell.tsx frontend/src/app/plan/plan-tabs.tsx frontend/src/app/plan/plan-client.tsx
git commit -m "feat: plan tabs, right-rail slot, matrix theme tokens"
```

---

### Task 8: Matrix route + data client (types, fetch, pin mutations, states)

**Files:**
- Create: `frontend/src/app/plan/matrix/page.tsx`
- Create: `frontend/src/app/plan/matrix/matrix-types.ts`
- Create: `frontend/src/app/plan/matrix/matrix-client.tsx`

**Interfaces:**
- Consumes: Task 6's API, Task 7's `PlanTabs`/`RightRail`/`sendJson`.
- Produces (consumed by Tasks 9–11): the types module below, and `MatrixClient` which owns: `plotted: PlottedItem[]` (effective coords), `selectedId`, pin/release mutations, and renders `<MatrixChart>` + `<ExecutionQueue>` (stubs until Tasks 9–10 land — this task ships with minimal inline placeholders so the route compiles and shows data counts).

- [ ] **Step 1: Create `frontend/src/app/plan/matrix/matrix-types.ts`**

```ts
export type PriorityFactor = {
  axis: "urgency" | "importance";
  sign: "+" | "-";
  text: string;
  source: "signal" | "llm";
  weight: number;
};

export type MatrixItem = {
  issue_id: number;
  number: number;
  title: string;
  urgency: number | null;
  importance: number | null;
  factors: PriorityFactor[];
  issue_type: "bug" | "feature" | "debt" | "question" | "docs" | null;
  component: string | null;
  readiness_score: number | null;
  labels: { name: string; color: string }[];
  assignees: string[];
  estimate: number;
  pinned: boolean;
  pinned_urgency: number | null;
  pinned_importance: number | null;
  scored_at: string | null;
  model: string | null;
};

export type MatrixPayload = {
  items: MatrixItem[];
  total: number;
  scored: number;
  unscored: number;
};

/** An item with effective (pin-overridden) coordinates, ready to plot. */
export type PlottedItem = MatrixItem & { u: number; i: number };

export type Quadrant = "dofirst" | "schedule" | "delegate" | "reconsider";

export type Series = "bug" | "feature" | "debt" | "other";

export function toPlotted(items: MatrixItem[]): PlottedItem[] {
  return items.flatMap((item) => {
    const u = item.pinned ? item.pinned_urgency : item.urgency;
    const i = item.pinned ? item.pinned_importance : item.importance;
    return u == null || i == null ? [] : [{ ...item, u, i }];
  });
}

export function quadrantOf(item: PlottedItem): Quadrant {
  if (item.u >= 50) return item.i >= 50 ? "dofirst" : "delegate";
  return item.i >= 50 ? "schedule" : "reconsider";
}

export function seriesOf(item: MatrixItem): Series {
  if (item.issue_type === "bug" || item.issue_type === "feature" || item.issue_type === "debt") {
    return item.issue_type;
  }
  return "other";
}

export const SERIES_VAR: Record<Series, string> = {
  bug: "var(--pm-bug)",
  feature: "var(--pm-feature)",
  debt: "var(--pm-debt)",
  other: "var(--pm-other)",
};

export const QUADRANT_LABEL: Record<Quadrant, string> = {
  dofirst: "Do First",
  schedule: "Schedule",
  delegate: "Delegate",
  reconsider: "Reconsider",
};
```

- [ ] **Step 2: Create `frontend/src/app/plan/matrix/page.tsx`**

```tsx
import { Suspense } from "react";
import { MatrixClient } from "./matrix-client";

export default function MatrixPage() {
  return (
    <Suspense fallback={null}>
      <MatrixClient />
    </Suspense>
  );
}
```

- [ ] **Step 3: Create `frontend/src/app/plan/matrix/matrix-client.tsx`**

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
import { PlanTabs } from "../plan-tabs";
import {
  toPlotted,
  type MatrixItem,
  type MatrixPayload,
} from "./matrix-types";

const card =
  "rounded-[14px] border border-(--color-border) bg-(--color-surface) shadow-(--shadow-card)";

type Repo = { id: number; full_name: string };

export function MatrixClient() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const queryClient = useQueryClient();

  const { data: repos, isPending: reposPending } = useQuery({
    queryKey: ["repositories"],
    queryFn: () => getJson<Repo[]>("/api/backend/repositories"),
  });

  const repoParam = searchParams.get("repo_id");
  const repoId = repoParam ? Number(repoParam) : (repos?.[0]?.id ?? null);
  const matrixKey = ["matrix", repoId] as const;

  const { data, error, isPending } = useQuery({
    queryKey: matrixKey,
    queryFn: () => getJson<MatrixPayload>(`/api/backend/repositories/${repoId}/priority`),
    enabled: repoId != null,
    placeholderData: keepPreviousData,
  });

  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [mutationError, setMutationError] = useState<string | null>(null);

  const patchItem = useCallback(
    (issueId: number, patch: Partial<MatrixItem>) => {
      queryClient.setQueryData<MatrixPayload>(matrixKey, (old) =>
        old
          ? {
              ...old,
              items: old.items.map((item) =>
                item.issue_id === issueId ? { ...item, ...patch } : item,
              ),
            }
          : old,
      );
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [queryClient, repoId],
  );

  const pinMutation = useMutation({
    mutationFn: ({ issueId, urgency, importance }: {
      issueId: number; urgency: number; importance: number;
    }) =>
      sendJson<{ issue_id: number }>(`/api/backend/issues/${issueId}/pin`, "PUT", {
        urgency,
        importance,
      }),
    onMutate: async ({ issueId, urgency, importance }) => {
      await queryClient.cancelQueries({ queryKey: matrixKey });
      const previous = queryClient.getQueryData<MatrixPayload>(matrixKey);
      patchItem(issueId, {
        pinned: true,
        pinned_urgency: urgency,
        pinned_importance: importance,
      });
      setMutationError(null);
      return { previous };
    },
    onError: (err, _vars, context) => {
      if (context?.previous) queryClient.setQueryData(matrixKey, context.previous);
      setMutationError(err.message);
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: matrixKey }),
  });

  const releaseMutation = useMutation({
    mutationFn: (issueId: number) =>
      sendJson<undefined>(`/api/backend/issues/${issueId}/pin`, "DELETE"),
    onMutate: async (issueId) => {
      await queryClient.cancelQueries({ queryKey: matrixKey });
      const previous = queryClient.getQueryData<MatrixPayload>(matrixKey);
      patchItem(issueId, { pinned: false, pinned_urgency: null, pinned_importance: null });
      setMutationError(null);
      return { previous };
    },
    onError: (err, _vars, context) => {
      if (context?.previous) queryClient.setQueryData(matrixKey, context.previous);
      setMutationError(err.message);
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: matrixKey }),
  });

  const items = data?.items ?? [];
  const plotted = toPlotted(items);
  const selected = items.find((item) => item.issue_id === selectedId) ?? null;

  return (
    <div className="flex flex-col gap-4" data-testid="matrix-content">
      <div className="flex items-baseline gap-3">
        <h1 className="text-lg font-semibold tracking-[-0.01em]">Plan</h1>
        <span className="text-(--color-text-muted)">
          Urgency × importance — drag a bubble to pin it
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
              e.target.value ? `/plan/matrix?repo_id=${e.target.value}` : "/plan/matrix",
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
        {data && data.unscored > 0 ? (
          <span
            className="rounded-full border border-(--color-border) px-2 py-0.5 text-[10px] text-(--color-text-muted)"
            data-testid="unscored-chip"
          >
            {data.unscored} issue{data.unscored === 1 ? "" : "s"} awaiting scores
          </span>
        ) : null}
        {mutationError ? (
          <span className="text-(--color-danger)" data-testid="pin-error">
            {mutationError}
          </span>
        ) : null}
      </div>

      {reposPending || (repoId != null && isPending) ? (
        <div className={`${card} px-6 py-16 text-center text-(--color-text-muted)`}>
          Loading matrix…
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
            Install the IssueLens GitHub App and sync a repository to plot its
            issues here.
          </div>
          <Link className="pt-2 text-(--color-primary) hover:underline" href="/repositories">
            Go to Repositories →
          </Link>
        </div>
      ) : plotted.length === 0 ? (
        <div className={`${card} px-6 py-16 text-center text-(--color-text-muted)`}>
          No scored issues yet — scores appear after the next analysis run.
        </div>
      ) : (
        <MatrixBoard
          plotted={plotted}
          selected={selected}
          onSelect={setSelectedId}
          onPin={(issueId, urgency, importance) =>
            pinMutation.mutate({ issueId, urgency, importance })
          }
          onRelease={(issueId) => releaseMutation.mutate(issueId)}
        />
      )}
    </div>
  );
}

/** Placeholder container — replaced by chart + queue in the next two tasks. */
function MatrixBoard(props: {
  plotted: ReturnType<typeof toPlotted>;
  selected: MatrixItem | null;
  onSelect: (id: number | null) => void;
  onPin: (issueId: number, urgency: number, importance: number) => void;
  onRelease: (issueId: number) => void;
}) {
  return (
    <div className={`${card} p-4 text-(--color-text-muted)`} data-testid="matrix-board">
      {props.plotted.length} scored issues ready to plot.
    </div>
  );
}
```

- [ ] **Step 4: Lint + manual smoke**

Run: `cd frontend && npm run lint`
Expected: clean. Visiting `/plan/matrix` (dev server) shows the tabs, repo select, and the placeholder count card.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/app/plan/matrix
git commit -m "feat: matrix route with data client and pin mutations"
```

---

### Task 9: SVG matrix chart with drag-to-pin

**Files:**
- Create: `frontend/src/app/plan/matrix/matrix-chart.tsx`
- Modify: `frontend/src/app/plan/matrix/matrix-client.tsx` (replace the `MatrixBoard` placeholder's card with the chart; keep the queue for Task 10)

**Interfaces:**
- Consumes: Task 8's types.
- Produces: `<MatrixChart plotted selectedId onSelect(id) onPin(id,u,i) onHover(item|null, cx, cy) />`. Geometry constants exported for tests/queue reuse: `VIEW_W=860`, `VIEW_H=560`, `PLOT = {left: 52, right: 842, top: 18, bottom: 514}`. `xOf(u) = 52 + u * 7.9`, `yOf(i) = 514 - i * 4.96`. Bubble radius `8 + estimate * 2.1`. Bubbles carry `data-testid="bubble-<number>"`; the pinned dashed ring carries `data-testid="pin-ring-<number>"`.

- [ ] **Step 1: Create `frontend/src/app/plan/matrix/matrix-chart.tsx`**

```tsx
"use client";

import { useRef, useState, type PointerEvent } from "react";
import {
  SERIES_VAR,
  seriesOf,
  type PlottedItem,
} from "./matrix-types";

export const VIEW_W = 860;
export const VIEW_H = 560;
export const PLOT = { left: 52, right: 842, top: 18, bottom: 514 };
const PLOT_W = PLOT.right - PLOT.left; // 790
const PLOT_H = PLOT.bottom - PLOT.top; // 496
const DRAG_THRESHOLD_PX = 3;

export function xOf(u: number): number {
  return PLOT.left + (u / 100) * PLOT_W;
}
export function yOf(i: number): number {
  return PLOT.bottom - (i / 100) * PLOT_H;
}
export function radiusOf(estimate: number): number {
  return 8 + estimate * 2.1;
}

type DragState = {
  issueId: number;
  startX: number;
  startY: number;
  moved: boolean;
  u: number;
  i: number;
};

const QUADRANT_RECTS = [
  { x: PLOT.left, y: PLOT.top, w: PLOT_W / 2, h: PLOT_H / 2, fill: "var(--quad-schedule)", label: "SCHEDULE", lx: PLOT.left + 12, ly: PLOT.top + 20 },
  { x: PLOT.left + PLOT_W / 2, y: PLOT.top, w: PLOT_W / 2, h: PLOT_H / 2, fill: "var(--quad-dofirst)", label: "DO FIRST", lx: PLOT.right - 12, ly: PLOT.top + 20, anchor: "end" as const },
  { x: PLOT.left + PLOT_W / 2, y: PLOT.top + PLOT_H / 2, w: PLOT_W / 2, h: PLOT_H / 2, fill: "var(--quad-delegate)", label: "DELEGATE / QUICK WINS", lx: PLOT.right - 12, ly: PLOT.bottom - 10, anchor: "end" as const },
  { x: PLOT.left, y: PLOT.top + PLOT_H / 2, w: PLOT_W / 2, h: PLOT_H / 2, fill: "var(--quad-reconsider)", label: "RECONSIDER", lx: PLOT.left + 12, ly: PLOT.bottom - 10 },
];

export function MatrixChart({
  plotted,
  selectedId,
  onSelect,
  onPin,
  onHover,
}: {
  plotted: PlottedItem[];
  selectedId: number | null;
  onSelect: (id: number | null) => void;
  onPin: (issueId: number, urgency: number, importance: number) => void;
  onHover: (item: PlottedItem | null, cx: number, cy: number) => void;
}) {
  const svgRef = useRef<SVGSVGElement | null>(null);
  const [drag, setDrag] = useState<DragState | null>(null);

  const clientToChart = (e: PointerEvent): { u: number; i: number } => {
    const rect = svgRef.current!.getBoundingClientRect();
    const x = ((e.clientX - rect.left) / rect.width) * VIEW_W;
    const y = ((e.clientY - rect.top) / rect.height) * VIEW_H;
    const u = Math.max(0, Math.min(100, ((x - PLOT.left) / PLOT_W) * 100));
    const i = Math.max(0, Math.min(100, ((PLOT.bottom - y) / PLOT_H) * 100));
    return { u, i };
  };

  const onBubbleDown = (item: PlottedItem) => (e: PointerEvent<SVGGElement>) => {
    try {
      (e.currentTarget as Element & { setPointerCapture(id: number): void }).setPointerCapture(
        e.pointerId,
      );
    } catch {
      // pointer capture is best-effort; drag still works without it
    }
    setDrag({
      issueId: item.issue_id,
      startX: e.clientX,
      startY: e.clientY,
      moved: false,
      u: item.u,
      i: item.i,
    });
  };

  const onBubbleMove = (e: PointerEvent<SVGGElement>) => {
    if (!drag) return;
    const dx = e.clientX - drag.startX;
    const dy = e.clientY - drag.startY;
    const moved =
      drag.moved || Math.hypot(dx, dy) > DRAG_THRESHOLD_PX;
    const { u, i } = clientToChart(e);
    setDrag({ ...drag, moved, u, i });
  };

  const onBubbleUp = (item: PlottedItem) => (e: PointerEvent<SVGGElement>) => {
    if (!drag || drag.issueId !== item.issue_id) return;
    if (drag.moved) {
      const { u, i } = clientToChart(e);
      onPin(item.issue_id, Math.round(u * 10) / 10, Math.round(i * 10) / 10);
    } else {
      onSelect(selectedId === item.issue_id ? null : item.issue_id);
    }
    setDrag(null);
  };

  return (
    <div className="rounded-[14px] border border-(--color-border) bg-(--color-surface) p-3 shadow-(--shadow-card)">
      <svg
        ref={svgRef}
        viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
        className="w-full touch-none select-none"
        role="img"
        aria-label="Priority matrix: urgency by importance"
        data-testid="matrix-chart"
      >
        {QUADRANT_RECTS.map((q) => (
          <g key={q.label}>
            <rect x={q.x} y={q.y} width={q.w} height={q.h} fill={q.fill} />
            <text
              x={q.lx}
              y={q.ly}
              textAnchor={q.anchor ?? "start"}
              fill="var(--color-text-muted)"
              fontSize="11"
              fontWeight="600"
              letterSpacing="0.08em"
            >
              {q.label}
            </text>
          </g>
        ))}

        {/* grid + axes */}
        <line x1={PLOT.left} y1={PLOT.top + PLOT_H / 2} x2={PLOT.right} y2={PLOT.top + PLOT_H / 2} stroke="var(--chart-grid)" />
        <line x1={PLOT.left + PLOT_W / 2} y1={PLOT.top} x2={PLOT.left + PLOT_W / 2} y2={PLOT.bottom} stroke="var(--chart-grid)" />
        <line x1={PLOT.left} y1={PLOT.bottom} x2={PLOT.right} y2={PLOT.bottom} stroke="var(--chart-axis)" />
        <line x1={PLOT.left} y1={PLOT.top} x2={PLOT.left} y2={PLOT.bottom} stroke="var(--chart-axis)" />
        {[0, 50, 100].map((tick) => (
          <g key={tick}>
            <text x={xOf(tick)} y={VIEW_H - 24} textAnchor="middle" fill="var(--color-text-muted)" fontSize="11">
              {tick}
            </text>
            <text x={PLOT.left - 10} y={yOf(tick) + 4} textAnchor="end" fill="var(--color-text-muted)" fontSize="11">
              {tick}
            </text>
          </g>
        ))}
        <text x={PLOT.right} y={VIEW_H - 6} textAnchor="end" fill="var(--color-text-muted)" fontSize="11">
          Urgency →
        </text>
        <text x={14} y={PLOT.top + 10} fill="var(--color-text-muted)" fontSize="11">
          Importance ↑
        </text>

        {plotted.map((item) => {
          const dragging = drag?.issueId === item.issue_id && drag.moved;
          const u = dragging ? drag.u : item.u;
          const i = dragging ? drag.i : item.i;
          const cx = xOf(u);
          const cy = yOf(i);
          const r = radiusOf(item.estimate);
          const color = SERIES_VAR[seriesOf(item)];
          const isSelected = selectedId === item.issue_id;
          return (
            <g
              key={item.issue_id}
              data-testid={`bubble-${item.number}`}
              className="cursor-grab"
              onPointerDown={onBubbleDown(item)}
              onPointerMove={onBubbleMove}
              onPointerUp={onBubbleUp(item)}
              onPointerEnter={() => onHover(item, cx, cy)}
              onPointerLeave={() => onHover(null, 0, 0)}
            >
              {item.pinned ? (
                <circle
                  data-testid={`pin-ring-${item.number}`}
                  cx={cx}
                  cy={cy}
                  r={r + 5}
                  fill="none"
                  stroke="var(--pin-ring)"
                  strokeDasharray="4 3"
                />
              ) : null}
              {isSelected ? (
                <circle cx={cx} cy={cy} r={r + 9} fill="none" stroke="var(--color-primary)" strokeWidth="1.5" />
              ) : null}
              <circle
                cx={cx}
                cy={cy}
                r={r}
                fill={color}
                stroke="var(--color-surface)"
                strokeWidth="2"
              />
              <text
                x={cx}
                y={cy + 3.5}
                textAnchor="middle"
                fontSize="10"
                fontWeight="600"
                fill="var(--color-text)"
                stroke="var(--color-surface)"
                strokeWidth="2.5"
                paintOrder="stroke"
                style={{ pointerEvents: "none" }}
              >
                #{item.number}
              </text>
            </g>
          );
        })}
      </svg>

      <div className="flex items-center gap-4 px-2 pt-2" data-testid="matrix-legend">
        {(["bug", "feature", "debt", "other"] as const).map((series) => (
          <span key={series} className="flex items-center gap-1.5 text-(--color-text-muted)">
            <span
              className="inline-block h-2.5 w-2.5 rounded-full"
              style={{ background: SERIES_VAR[series] }}
            />
            {series}
          </span>
        ))}
        <span className="grow" />
        <span className="text-(--color-text-muted)">size = effort · dashed ring = pinned</span>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Use it in `matrix-client.tsx`**

Replace the placeholder `MatrixBoard` function entirely and its call site with a two-column layout that renders the chart (queue arrives next task). At the call site:

```tsx
        <MatrixChart
          plotted={plotted}
          selectedId={selectedId}
          onSelect={setSelectedId}
          onPin={(issueId, urgency, importance) =>
            pinMutation.mutate({ issueId, urgency, importance })
          }
          onHover={() => {}}
        />
```

Add the import: `import { MatrixChart } from "./matrix-chart";` and delete `MatrixBoard` plus its unused props/type imports. (`onHover` gets a real handler in Task 11; `onRelease` usage arrives with the toast in Task 11 — remove the now-unused `releaseMutation` reference by prefixing nothing; keep `releaseMutation` defined, it is used in Task 11.)

- [ ] **Step 3: Lint + visual smoke via Playwright CLI**

Run: `cd frontend && npm run lint`
Then with the dev stack running, capture a screenshot to eyeball quadrants/bubbles/labels:
`npx playwright screenshot --viewport-size=1440,900 http://localhost:3005/plan/matrix matrix-smoke.png`
Expected: chart card with 4 tinted quadrants, labeled bubbles, legend. Delete the screenshot after checking; do not commit it.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/app/plan/matrix/matrix-chart.tsx frontend/src/app/plan/matrix/matrix-client.tsx
git commit -m "feat: draggable priority matrix chart"
```

---

### Task 10: Execution queue with flash re-rank and click-to-locate

**Files:**
- Create: `frontend/src/app/plan/matrix/execution-queue.tsx`
- Modify: `frontend/src/app/plan/matrix/matrix-client.tsx` (render queue into `<RightRail>`)

**Interfaces:**
- Consumes: Tasks 7–9 (`RightRail`, types, chart selection).
- Produces: `<ExecutionQueue plotted selectedId onSelect(id) />`. Rows carry `data-testid="qrow-<number>"`; groups carry `data-testid="qgroup-<quadrant>"`. Rank = position in `urgency + importance` descending order within quadrant group; groups ordered Do First → Schedule → Delegate → Reconsider. A row whose rank or group changed since the previous render gets the `qrow-flash` class. Clicking a row selects the issue; selecting a bubble scrolls its row into view.

- [ ] **Step 1: Create `frontend/src/app/plan/matrix/execution-queue.tsx`**

```tsx
"use client";

import { useEffect, useRef } from "react";
import {
  QUADRANT_LABEL,
  quadrantOf,
  SERIES_VAR,
  seriesOf,
  type PlottedItem,
  type Quadrant,
} from "./matrix-types";

const GROUP_ORDER: Quadrant[] = ["dofirst", "schedule", "delegate", "reconsider"];

export function ExecutionQueue({
  plotted,
  selectedId,
  onSelect,
}: {
  plotted: PlottedItem[];
  selectedId: number | null;
  onSelect: (id: number | null) => void;
}) {
  // rank signature per issue: "<quadrant>:<index>" — change triggers the flash
  const prevRanks = useRef<Map<number, string>>(new Map());
  const flashIds = useRef<Set<number>>(new Set());

  const groups = GROUP_ORDER.map((quadrant) => ({
    quadrant,
    items: plotted
      .filter((item) => quadrantOf(item) === quadrant)
      .sort((a, b) => b.u + b.i - (a.u + a.i)),
  }));

  const nextRanks = new Map<number, string>();
  for (const group of groups) {
    group.items.forEach((item, index) =>
      nextRanks.set(item.issue_id, `${group.quadrant}:${index}`),
    );
  }
  flashIds.current = new Set(
    [...nextRanks].filter(([id, sig]) => {
      const prev = prevRanks.current.get(id);
      return prev !== undefined && prev !== sig;
    }).map(([id]) => id),
  );

  useEffect(() => {
    prevRanks.current = nextRanks;
  });

  useEffect(() => {
    if (selectedId == null) return;
    document
      .querySelector(`[data-qrow-id="${selectedId}"]`)
      ?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [selectedId]);

  return (
    <div
      className="flex max-h-[calc(100vh-120px)] flex-col gap-3 overflow-y-auto rounded-[14px] border border-(--color-border) bg-(--color-surface) p-4 shadow-(--shadow-card)"
      data-testid="execution-queue"
    >
      <div className="text-[10px] font-semibold tracking-[0.08em] text-(--color-text-muted) uppercase">
        Execution queue
      </div>
      {groups.map(({ quadrant, items }) =>
        items.length === 0 ? null : (
          <div key={quadrant} data-testid={`qgroup-${quadrant}`}>
            <div className="pb-1 text-[10px] font-semibold tracking-[0.08em] text-(--color-text-muted) uppercase">
              {QUADRANT_LABEL[quadrant]}
            </div>
            <ul className="flex flex-col">
              {items.map((item, index) => (
                <li key={item.issue_id}>
                  <button
                    type="button"
                    data-qrow-id={item.issue_id}
                    data-testid={`qrow-${item.number}`}
                    onClick={() =>
                      onSelect(selectedId === item.issue_id ? null : item.issue_id)
                    }
                    className={`flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left transition-all duration-150 ${
                      flashIds.current.has(item.issue_id) ? "qrow-flash" : ""
                    } ${
                      selectedId === item.issue_id
                        ? "bg-(--accent-tint)"
                        : "hover:bg-(--accent-tint)"
                    }`}
                  >
                    <span className="w-4 text-right text-(--color-text-muted) tabular-nums">
                      {index + 1}
                    </span>
                    <span
                      className="inline-block h-2 w-2 shrink-0 rounded-full"
                      style={{ background: SERIES_VAR[seriesOf(item)] }}
                    />
                    <span className="text-(--color-text-muted)">#{item.number}</span>
                    <span className="min-w-0 grow truncate" title={item.title}>
                      {item.title}
                    </span>
                    <span className="text-(--color-text-muted) tabular-nums">
                      {Math.round(item.u + item.i)}
                    </span>
                    {item.pinned ? <span aria-label="pinned">📌</span> : null}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        ),
      )}
    </div>
  );
}
```

- [ ] **Step 2: Render the queue in the right rail**

In `matrix-client.tsx`, add imports:

```tsx
import { RightRail } from "../../../components/right-rail";
import { ExecutionQueue } from "./execution-queue";
```

Inside the success branch (where `MatrixChart` renders), wrap as:

```tsx
        <>
          <MatrixChart
            plotted={plotted}
            selectedId={selectedId}
            onSelect={setSelectedId}
            onPin={(issueId, urgency, importance) =>
              pinMutation.mutate({ issueId, urgency, importance })
            }
            onHover={() => {}}
          />
          <RightRail>
            <ExecutionQueue
              plotted={plotted}
              selectedId={selectedId}
              onSelect={setSelectedId}
            />
          </RightRail>
        </>
```

- [ ] **Step 3: Lint + smoke**

Run: `cd frontend && npm run lint`
Expected: clean. In the dev app: queue replaces the "Context" card on `/plan/matrix` only; navigating back to `/plan` restores the fallback card. Drag a bubble across the 50-line → its row flashes and moves groups.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/app/plan/matrix/execution-queue.tsx frontend/src/app/plan/matrix/matrix-client.tsx
git commit -m "feat: execution queue with flash re-rank and click-to-locate"
```

---

### Task 11: Hover explainability card + pinned toast (Release to AI)

**Files:**
- Create: `frontend/src/app/plan/matrix/hover-card.tsx`
- Modify: `frontend/src/app/plan/matrix/matrix-client.tsx` (hover state, toast, release wiring)

**Interfaces:**
- Consumes: everything prior.
- Produces: `<MatrixHoverCard item cx cy />` (positioned over the chart, `data-testid="hover-card"`); a toast (`data-testid="pin-toast"`) shown while the selected item is pinned, with a **Release to AI** button (`data-testid="release-pin"`) that calls the DELETE mutation.

- [ ] **Step 1: Create `frontend/src/app/plan/matrix/hover-card.tsx`**

```tsx
"use client";

import type { PlottedItem } from "./matrix-types";
import { VIEW_H, VIEW_W } from "./matrix-chart";

export function MatrixHoverCard({
  item,
  cx,
  cy,
}: {
  item: PlottedItem;
  cx: number;
  cy: number;
}) {
  const left = `${Math.min(78, (cx / VIEW_W) * 100)}%`;
  const top = `${Math.min(70, (cy / VIEW_H) * 100)}%`;
  return (
    <div
      data-testid="hover-card"
      className="pointer-events-none absolute z-10 w-72 rounded-lg border border-(--color-border) bg-(--color-surface) p-3 shadow-(--shadow-card)"
      style={{ left, top }}
    >
      <div className="flex items-baseline gap-2">
        <span className="text-(--color-text-muted)">#{item.number}</span>
        <span className="min-w-0 truncate font-medium">{item.title}</span>
      </div>
      <div className="flex gap-3 pt-1 text-(--color-text-muted)">
        <span>{item.issue_type ?? "unclassified"}</span>
        {item.readiness_score != null ? <span>readiness {item.readiness_score}%</span> : null}
        <span className="tabular-nums">
          U {Math.round(item.u)} / I {Math.round(item.i)}
        </span>
        {item.pinned ? <span>pinned</span> : null}
      </div>
      {item.factors.length > 0 ? (
        <ul className="flex flex-col gap-0.5 pt-2" data-testid="hover-factors">
          {item.factors.map((factor, index) => (
            <li key={index} className="flex items-start gap-1.5">
              <span
                className={
                  factor.sign === "+" ? "text-(--pm-feature)" : "text-(--color-danger)"
                }
              >
                {factor.sign}
              </span>
              <span className="min-w-0 grow">{factor.text}</span>
              {factor.source === "llm" ? (
                <span className="rounded-full border border-(--color-border) px-1 text-[9px] text-(--color-text-muted)">
                  AI
                </span>
              ) : null}
            </li>
          ))}
        </ul>
      ) : (
        <div className="pt-2 text-(--color-text-muted)">Awaiting scores.</div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Wire hover + toast in `matrix-client.tsx`**

Add state and imports:

```tsx
import { MatrixHoverCard } from "./hover-card";
// state, next to selectedId:
const [hover, setHover] = useState<{ item: PlottedItem; cx: number; cy: number } | null>(null);
```

(Import `PlottedItem` type from `./matrix-types`.) Replace the chart block with a relative wrapper and real handlers, and add the toast after the `</RightRail>`:

```tsx
        <>
          <div className="relative">
            <MatrixChart
              plotted={plotted}
              selectedId={selectedId}
              onSelect={setSelectedId}
              onPin={(issueId, urgency, importance) => {
                setHover(null);
                pinMutation.mutate({ issueId, urgency, importance });
              }}
              onHover={(item, cx, cy) => setHover(item ? { item, cx, cy } : null)}
            />
            {hover ? <MatrixHoverCard item={hover.item} cx={hover.cx} cy={hover.cy} /> : null}
          </div>
          <RightRail>
            <ExecutionQueue
              plotted={plotted}
              selectedId={selectedId}
              onSelect={setSelectedId}
            />
          </RightRail>
          {selected?.pinned ? (
            <div
              data-testid="pin-toast"
              className="fixed bottom-6 left-1/2 z-20 flex -translate-x-1/2 items-center gap-3 rounded-[14px] border border-(--color-border) bg-(--color-surface) px-4 py-2.5 shadow-(--shadow-card)"
            >
              <span>
                #{selected.number} is pinned — the AI will not move it.
              </span>
              <button
                type="button"
                data-testid="release-pin"
                className="rounded-lg border border-(--color-border) px-2.5 py-1 text-(--color-primary) transition-all duration-150 hover:bg-(--accent-tint)"
                onClick={() => releaseMutation.mutate(selected.issue_id)}
              >
                Release to AI
              </button>
              <button
                type="button"
                aria-label="Dismiss"
                className="text-(--color-text-muted) transition-all duration-150 hover:text-(--color-text)"
                onClick={() => setSelectedId(null)}
              >
                ✕
              </button>
            </div>
          ) : null}
        </>
```

- [ ] **Step 3: Lint + smoke**

Run: `cd frontend && npm run lint`
Expected: clean. Hovering a bubble shows the factor card with AI tags; clicking a pinned bubble shows the toast; Release removes the dashed ring and the toast (item returns to its computed spot).

- [ ] **Step 4: Commit**

```bash
git add frontend/src/app/plan/matrix/hover-card.tsx frontend/src/app/plan/matrix/matrix-client.tsx
git commit -m "feat: matrix hover explainability and release-to-ai toast"
```

---

### Task 12: Playwright e2e for the matrix

**Files:**
- Create: `frontend/e2e/matrix.spec.ts`

**Interfaces:**
- Consumes: all frontend testids introduced in Tasks 8–11 (`matrix-content`, `unscored-chip`, `bubble-<n>`, `pin-ring-<n>`, `qrow-<n>`, `qgroup-<quadrant>`, `hover-card`, `hover-factors`, `pin-toast`, `release-pin`, `plan-tabs`, `execution-queue`).

- [ ] **Step 1: Write the spec**

`frontend/e2e/matrix.spec.ts`:

```ts
import { expect, test, type Page, type Route } from "@playwright/test";

const factor = (over: Partial<Record<string, unknown>> = {}) => ({
  axis: "urgency",
  sign: "+",
  text: "Priority P0 set",
  source: "signal",
  weight: 30,
  ...over,
});

const item = (over: Partial<Record<string, unknown>> = {}) => ({
  issue_id: 1,
  number: 42,
  title: "Fix token refresh",
  urgency: 80,
  importance: 70,
  factors: [
    factor(),
    factor({ axis: "importance", text: "Customer reports login broken", source: "llm", weight: 0 }),
  ],
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
    item({ issue_id: 2, number: 43, title: "Docs typo", urgency: 20, importance: 15, issue_type: "docs", factors: [factor({ sign: "-", text: "No milestone (urgency uncertain)" })] }),
    item({ issue_id: 3, number: 44, title: "Awaiting analysis", urgency: null, importance: null, factors: [] }),
  ],
  total: 3,
  scored: 2,
  unscored: 1,
};

const repos = [{ id: 500, full_name: "patelmj/mehova" }];

/**
 * Stateful stub: the PUT/DELETE handlers mutate `pinned`, and the GET reflects it —
 * mirrors the real backend so the post-mutation refetch (invalidateQueries) never
 * races the assertions.
 */
async function stubMatrix(page: Page, calls?: { pins: unknown[]; releases: number }) {
  let pinned: { u: number; i: number } | null = null;
  await page.route(/\/api\/backend\/repositories$/, (route: Route) =>
    route.fulfill({ json: repos }),
  );
  await page.route(/\/api\/backend\/repositories\/500\/priority$/, (route: Route) => {
    const items = payload.items.map((it) =>
      it.issue_id === 1
        ? {
            ...it,
            pinned: pinned != null,
            pinned_urgency: pinned?.u ?? null,
            pinned_importance: pinned?.i ?? null,
          }
        : it,
    );
    return route.fulfill({ json: { ...payload, items } });
  });
  await page.route(/\/api\/backend\/issues\/\d+\/pin$/, (route: Route) => {
    if (route.request().method() === "PUT") {
      const body = route.request().postDataJSON() as { urgency: number; importance: number };
      calls?.pins.push(body);
      pinned = { u: body.urgency, i: body.importance };
      return route.fulfill({
        json: {
          issue_id: 1,
          pinned: true,
          pinned_urgency: body.urgency,
          pinned_importance: body.importance,
        },
      });
    }
    if (calls) calls.releases += 1;
    pinned = null;
    return route.fulfill({ status: 204, body: "" });
  });
}

test("matrix renders bubbles, queue groups, and unscored chip", async ({ page }) => {
  await stubMatrix(page);
  await page.goto("/plan/matrix");
  await expect(page.getByTestId("bubble-42")).toBeVisible();
  await expect(page.getByTestId("bubble-43")).toBeVisible();
  await expect(page.getByTestId("unscored-chip")).toContainText("1 issue awaiting scores");
  await expect(page.getByTestId("qgroup-dofirst")).toContainText("#42");
  await expect(page.getByTestId("qgroup-reconsider")).toContainText("#43");
  await expect(page.getByTestId("execution-queue")).toBeVisible();
});

test("plan tabs navigate between table and matrix", async ({ page }) => {
  await stubMatrix(page);
  await page.route(/\/api\/backend\/issues\?/, (route: Route) =>
    route.fulfill({ json: { items: [], total: 0, limit: 50, offset: 0 } }),
  );
  await page.route(/\/api\/backend\/issues\/facets/, (route: Route) =>
    route.fulfill({ json: { labels: [], assignees: [], components: [] } }),
  );
  await page.goto("/plan/matrix");
  await page.getByTestId("plan-tabs").getByRole("link", { name: "Table" }).click();
  await expect(page.getByTestId("plan-content")).toBeVisible();
});

test("dragging a bubble pins it: PUT sent, ring + toast shown, queue reflows", async ({ page }) => {
  const calls = { pins: [] as unknown[], releases: 0 };
  await stubMatrix(page, calls);
  await page.goto("/plan/matrix");
  const bubble = page.getByTestId("bubble-42");
  await expect(bubble).toBeVisible();
  const box = (await bubble.boundingBox())!;
  const startX = box.x + box.width / 2;
  const startY = box.y + box.height / 2;
  await page.mouse.move(startX, startY);
  await page.mouse.down();
  await page.mouse.move(startX - 250, startY + 200, { steps: 8 });
  await page.mouse.up();

  await expect.poll(() => calls.pins.length).toBe(1);
  const sent = calls.pins[0] as { urgency: number; importance: number };
  expect(sent.urgency).toBeLessThan(80);
  expect(sent.importance).toBeLessThan(70);
  await expect(page.getByTestId("pin-ring-42")).toBeVisible();
  // pinned issue moved out of Do First
  await expect(page.getByTestId("qgroup-dofirst")).not.toContainText("#42");
});

test("release to AI restores computed placement", async ({ page }) => {
  const calls = { pins: [] as unknown[], releases: 0 };
  await stubMatrix(page, calls);
  await page.goto("/plan/matrix");
  const bubble = page.getByTestId("bubble-42");
  const box = (await bubble.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x - 250, box.y + 200, { steps: 8 });
  await page.mouse.up();
  await expect(page.getByTestId("pin-ring-42")).toBeVisible();

  // click (no movement) selects the pinned bubble → toast appears
  await page.getByTestId("bubble-42").click();
  await expect(page.getByTestId("pin-toast")).toBeVisible();
  await page.getByTestId("release-pin").click();
  await expect.poll(() => calls.releases).toBe(1);
  await expect(page.getByTestId("pin-ring-42")).not.toBeVisible();
  await expect(page.getByTestId("qgroup-dofirst")).toContainText("#42");
});

test("queue row click selects; bubble hover shows explainability with AI tag", async ({ page }) => {
  await stubMatrix(page);
  await page.goto("/plan/matrix");
  await page.getByTestId("qrow-43").click();
  await expect(page.getByTestId("qrow-43")).toHaveClass(/bg-\(--accent-tint\)/);

  await page.getByTestId("bubble-42").hover();
  await expect(page.getByTestId("hover-card")).toBeVisible();
  await expect(page.getByTestId("hover-factors")).toContainText("Priority P0 set");
  await expect(page.getByTestId("hover-factors")).toContainText("Customer reports login broken");
  await expect(page.getByTestId("hover-card")).toContainText("AI");
});
```

- [ ] **Step 2: Run the spec**

Run: `cd frontend && npx playwright test e2e/matrix.spec.ts`
Expected: all PASS. Debug failures with `--headed` and trace, not by weakening assertions; do not add sleeps — the stateful stub already makes mutation → refetch deterministic.

- [ ] **Step 3: Run the whole e2e suite**

Run: `cd frontend && npx playwright test`
Expected: all specs pass.

- [ ] **Step 4: Commit**

```bash
git add frontend/e2e/matrix.spec.ts
git commit -m "test: e2e for priority matrix drag, pin, release, and queue"
```

---

### Task 13: Full verification + wrap-up

**Files:**
- No new files. Verification + board follow-ups only.

- [ ] **Step 1: Full backend suite + lint**

Run: `cd backend && uv run pytest -q && uv run ruff check .`
Expected: everything passes.

- [ ] **Step 2: Full frontend lint + e2e**

Run: `cd frontend && npm run lint && npx playwright test`
Expected: everything passes.

- [ ] **Step 3: Live verification against the real stack (if Ollama + Postgres + Redis are up)**

Trigger a sync for a connected repo, wait for the worker chain (`sync → classify → readiness → priority`), then load `/plan/matrix`: real bubbles plot, dragging pins persist across reload, release restores. Report what was actually verified.

- [ ] **Step 4: File deferred follow-ups on the roadmap board**

Via the `todos` skill, create issues (Area: Views & Visualization unless noted) for: filter chips; propose-priority-change on quadrant cross; zoom/pan + clustering; lasso multi-select; saved matrix views; milestone due-date sync (Area: Data & Sync); dependency graph signals (Area: Data & Sync).

- [ ] **Step 5: Pause — do NOT open a PR**

Summarize the branch state to the user and ask whether to open a PR (per CLAUDE.md PR-based review methodology). The final whole-branch review (most-capable model) happens before that ask.

---

## Self-Review Notes (already applied)

- Spec coverage: §10.1 → Tasks 2–4; §10.2 → Tasks 1, 6, 9, 11 (pins never sync, release supported, re-analysis never touches pins — tested); §10.3 → Tasks 7–9 (size=effort, 4-series fold, ink labels + surface ring, quadrant tints); §10.4 core → Tasks 9–11 (hover, click-select, drag); queue → Task 10; explainability → Tasks 4, 6, 11; heuristic fallback → Task 4; unscored visibility → Tasks 6, 8; deferred list → Task 13.
- Type consistency: factor dict shape is identical across Tasks 2/3/4/6/8; `estimate` is int 1–5 everywhere; pin coords are floats 0–100; testids in Task 12 match Tasks 8–11 exactly.
- The chart's `--chart-grid`/`--chart-axis` tokens already exist in globals.css (added in slice 4).
```
