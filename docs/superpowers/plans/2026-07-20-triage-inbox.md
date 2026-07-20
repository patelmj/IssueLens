# Triage Inbox Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the read-only readiness data into an actionable triage loop — a Needs-Detail inbox that deterministically scaffolds the missing rubric sections, previews the change as a diff, and (on approval) pushes the new body to GitHub with write-safety.

**Architecture:** A new `app/triage/` package holds pure helpers (`scaffold.py` = deterministic section scaffolds keyed by rubric requirement id; `diff.py` = `difflib`-based structured diff) and a `service.py` orchestration layer (generate/get/update/push a single `issue_suggestions` row + the inbox query). A new `routers/triage.py` exposes the inbox and suggestion endpoints. GitHub write helpers are added to the existing `github/client.py`. The frontend replaces the `/triage` placeholder with an inbox table + a suggestion drawer.

**Tech Stack:** FastAPI + SQLAlchemy async + Alembic + PostgreSQL (backend); arq/Redis (re-score enqueue); httpx + respx (GitHub I/O + tests); Next.js (App Router) + React Query + Tailwind v4 (frontend); Playwright (e2e); Python stdlib `difflib` (no new deps).

## Global Constraints

- **No new dependencies** (frontend or backend) — diff is stdlib `difflib`; no npm `diff` package.
- **Tailwind v4 CSS custom properties use parentheses syntax:** `bg-(--color-x)`, `text-(--type-bug)` — never `bg-[--color-x]` brackets.
- **Inactive UI elements stay visible but muted** (change fill/color only), never hidden.
- **All UI testing via Playwright CLI**, never manual browser testing.
- **Commit messages carry NO author/attribution/Co-Authored-By/model tags.**
- **Frontend Next.js is a modified build** — consult `frontend/AGENTS.md`; `npm run lint` is the reliable gate (not `tsc --noEmit`, which is masked by a broken generated `.next/dev/types/validator.ts`).
- **Backend tests run against `issuelens_test`** (auto-created + migrated by `conftest.py`); use the `clean_db` fixture in any test that writes rows.
- **The AI never fabricates issue content** — scaffolds are empty labelled sections only.
- **One active `issue_suggestions` row per issue** (PK `issue_id`); regenerate replaces it.

---

### Task 1: `issue_suggestions` table + model

**Files:**
- Create: `backend/alembic/versions/0006_issue_suggestions.py`
- Modify: `backend/app/models.py` (append `IssueSuggestion`)
- Test: `backend/tests/test_models.py` (append one test)

**Interfaces:**
- Produces: `IssueSuggestion` ORM model with columns `issue_id` (PK, FK→issues, CASCADE), `status` (Text, default `'draft'`), `base_body` (Text), `base_gh_updated_at` (DateTime tz), `proposed_body` (Text), `missing_requirements` (JSONB), `edited` (Boolean, default False), `created_at`/`updated_at` (DateTime tz, server_default now), `pushed_at` (DateTime tz, nullable).

- [ ] **Step 1: Write the migration**

Create `backend/alembic/versions/0006_issue_suggestions.py`:

```python
"""issue suggestions"""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import JSONB

revision = "0006"
down_revision = "0005"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "issue_suggestions",
        sa.Column(
            "issue_id",
            sa.BigInteger(),
            sa.ForeignKey("issues.id", ondelete="CASCADE"),
            primary_key=True,
        ),
        sa.Column("status", sa.Text(), nullable=False, server_default="draft"),
        sa.Column("base_body", sa.Text(), nullable=False),
        sa.Column("base_gh_updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("proposed_body", sa.Text(), nullable=False),
        sa.Column("missing_requirements", JSONB(), nullable=False),
        sa.Column("edited", sa.Boolean(), nullable=False, server_default=sa.false()),
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
        sa.Column("pushed_at", sa.DateTime(timezone=True), nullable=True),
    )


def downgrade() -> None:
    op.drop_table("issue_suggestions")
```

- [ ] **Step 2: Add the model**

Append to `backend/app/models.py` (after `IssueReadiness`):

```python
class IssueSuggestion(Base):
    __tablename__ = "issue_suggestions"

    issue_id: Mapped[int] = mapped_column(
        BigInteger, ForeignKey("issues.id", ondelete="CASCADE"), primary_key=True
    )
    status: Mapped[str] = mapped_column(Text, default="draft", server_default="draft")
    base_body: Mapped[str] = mapped_column(Text)
    base_gh_updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    proposed_body: Mapped[str] = mapped_column(Text)
    missing_requirements: Mapped[list] = mapped_column(JSONB, default=list)
    edited: Mapped[bool] = mapped_column(Boolean, default=False, server_default=text("false"))
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )
    pushed_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
```

- [ ] **Step 3: Write the failing test**

Append to `backend/tests/test_models.py`:

```python
async def test_issue_suggestion_roundtrip(clean_db):
    from datetime import datetime, timezone

    from app.db import get_sessionmaker
    from app.models import (
        Installation,
        Issue,
        IssueSuggestion,
        Repository,
    )

    now = datetime.now(timezone.utc)
    async with get_sessionmaker()() as session:
        session.add(Installation(id=42, account_login="patelmj"))
        await session.flush()
        session.add(
            Repository(id=1, installation_id=42, full_name="o/r", owner="o", name="r")
        )
        await session.flush()
        session.add(
            Issue(
                id=1, repository_id=1, number=1, title="t", state="open",
                gh_created_at=now, gh_updated_at=now,
            )
        )
        await session.flush()
        session.add(
            IssueSuggestion(
                issue_id=1, status="draft", base_body="orig",
                base_gh_updated_at=now, proposed_body="orig\n## X\n",
                missing_requirements=[{"id": "repro_steps", "label": "Reproduction steps"}],
            )
        )
        await session.commit()

    async with get_sessionmaker()() as session:
        from sqlalchemy import select

        sug = (
            await session.execute(select(IssueSuggestion).where(IssueSuggestion.issue_id == 1))
        ).scalar_one()
        assert sug.status == "draft"
        assert sug.edited is False
        assert sug.missing_requirements[0]["id"] == "repro_steps"
        assert sug.pushed_at is None
```

- [ ] **Step 4: Run migration + test**

Run: `cd backend && python -m pytest tests/test_models.py::test_issue_suggestion_roundtrip -v`
Expected: PASS (the `test_database` session fixture runs `alembic upgrade head`, applying `0006`).

- [ ] **Step 5: Commit**

```bash
git add backend/alembic/versions/0006_issue_suggestions.py backend/app/models.py backend/tests/test_models.py
git commit -m "feat: issue_suggestions table and model"
```

---

### Task 2: Scaffold engine (`app/triage/scaffold.py`)

**Files:**
- Create: `backend/app/triage/__init__.py` (empty)
- Create: `backend/app/triage/scaffold.py`
- Test: `backend/tests/test_scaffold.py`

**Interfaces:**
- Consumes: `RUBRICS` from `app.llm.readiness` (requirement ids).
- Produces:
  - `SCAFFOLDS: dict[str, str]` — one markdown block per requirement id; each block's first line is an H2 heading.
  - `build_proposed_body(current_body: str, missing_requirement_ids: list[str]) -> tuple[str, list[str]]` — returns `(proposed_body, applied_requirement_ids)`. Appends each id's scaffold whose heading is not already present (any heading level), in the id order given. Idempotent.

- [ ] **Step 1: Write the failing test**

Create `backend/tests/test_scaffold.py`:

```python
from app.triage.scaffold import SCAFFOLDS, build_proposed_body


def test_scaffolds_cover_every_rubric_requirement():
    from app.llm.readiness import RUBRICS

    ids = {r.id for reqs in RUBRICS.values() for r in reqs}
    assert ids <= set(SCAFFOLDS), f"missing scaffolds for {ids - set(SCAFFOLDS)}"


def test_appends_missing_sections_in_order():
    body, applied = build_proposed_body("A bug happened.", ["repro_steps", "environment"])
    assert applied == ["repro_steps", "environment"]
    assert body.startswith("A bug happened.")
    assert "## Reproduction Steps" in body
    assert "## Environment" in body
    assert body.index("## Reproduction Steps") < body.index("## Environment")


def test_is_deterministic():
    a, _ = build_proposed_body("x", ["repro_steps", "logs"])
    b, _ = build_proposed_body("x", ["repro_steps", "logs"])
    assert a == b


def test_is_idempotent():
    once, _ = build_proposed_body("x", ["repro_steps"])
    twice, applied = build_proposed_body(once, ["repro_steps"])
    assert twice == once
    assert applied == []  # heading already present, nothing appended


def test_skips_heading_already_present_any_level():
    body, applied = build_proposed_body("### Environment\n- macOS\n", ["environment"])
    assert applied == []
    assert body.count("Environment") == 1


def test_empty_body():
    body, applied = build_proposed_body("", ["repro_steps"])
    assert body.startswith("## Reproduction Steps")
    assert applied == ["repro_steps"]
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && python -m pytest tests/test_scaffold.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'app.triage'`.

- [ ] **Step 3: Create the package and module**

Create empty `backend/app/triage/__init__.py`.

Create `backend/app/triage/scaffold.py`:

```python
import re

from app.llm.readiness import RUBRICS

# One markdown block per rubric requirement id (ids match RUBRICS in readiness.py).
# Each block's first line is an H2 heading; the rest is an empty labelled scaffold
# with guiding HTML comments. The AI never fills real content here.
SCAFFOLDS: dict[str, str] = {
    "problem_statement": "## Problem Statement\n<!-- What is happening, and why is it a problem? -->\n",
    "expected_behavior": "## Expected Behavior\n<!-- What should happen instead? -->\n",
    "actual_behavior": "## Actual Behavior\n<!-- What actually happens? -->\n",
    "repro_steps": "## Reproduction Steps\n<!-- Minimal steps to reproduce -->\n1. \n2. \n3. \n",
    "environment": "## Environment\n- OS / version: \n- App / dependency version: \n",
    "logs": "## Logs / Error Output\n<!-- Paste logs, stack traces, or screenshots -->\n```\n\n```\n",
    "severity": "## Severity / Impact\n<!-- Who is affected and how badly? -->\n",
    "ownership": "## Ownership / Area\n<!-- Which team, component, or code area owns this? -->\n",
    "user_problem": "## User / Business Problem\n<!-- Who needs this and why? -->\n",
    "desired_outcome": "## Desired Outcome\n<!-- What should be true once this ships? -->\n",
    "acceptance_criteria": "## Acceptance Criteria\n- [ ] \n- [ ] \n",
    "scope_boundaries": "## Scope\n**In scope:**\n- \n\n**Out of scope:**\n- \n",
    "technical_constraints": "## Technical Constraints\n<!-- APIs, performance limits, compatibility -->\n",
    "dependencies": "## Dependencies\n<!-- Blocking issues, PRs, or external decisions -->\n- \n",
    "estimate": "## Estimate\n<!-- Rough size (e.g. S/M/L or days) -->\n",
    "current_implementation": "## Current Implementation\n<!-- How does it work today? -->\n",
    "why_problem": "## Why It Is a Problem\n<!-- What pain does the current state cause? -->\n",
    "affected_systems": "## Affected Systems\n<!-- Which modules, services, or files are involved? -->\n",
    "proposed_direction": "## Proposed Direction\n<!-- Suggested approach, not necessarily final -->\n",
    "risk": "## Risk of Changing It\n<!-- What could break, and how do we de-risk? -->\n",
    "definition_of_done": "## Definition of Done\n- [ ] \n- [ ] \n",
    "what_wrong": "## What Is Wrong or Missing\n<!-- The documentation gap or error -->\n",
    "where": "## Where It Lives\n<!-- Page, section, file, or URL -->\n",
    "audience": "## Who It Affects\n<!-- Which readers, and why it matters -->\n",
    "proposed_correction": "## Proposed Correction\n<!-- Suggested fix or direction -->\n",
    "context": "## Context / Goal\n<!-- What are you trying to do? -->\n",
    "question_stated": "## Question\n<!-- State the specific question -->\n",
    "already_tried": "## What I Have Tried\n<!-- Approaches attempted and their results -->\n",
}

# Coupling guard: a new rubric requirement cannot ship without a scaffold.
_RUBRIC_IDS = {r.id for reqs in RUBRICS.values() for r in reqs}
assert _RUBRIC_IDS <= set(SCAFFOLDS), (
    f"SCAFFOLDS missing entries for rubric ids: {_RUBRIC_IDS - set(SCAFFOLDS)}"
)


def _heading_of(scaffold: str) -> str:
    """The heading text on the scaffold's first line, e.g. 'Reproduction Steps'."""
    first_line = scaffold.splitlines()[0]
    return first_line.lstrip("#").strip()


def _heading_present(body: str, heading: str) -> bool:
    """True if `body` already contains a markdown heading (any level) for `heading`."""
    pattern = rf"(?im)^#{{1,6}}\s+{re.escape(heading)}\s*$"
    return re.search(pattern, body) is not None


def build_proposed_body(
    current_body: str, missing_requirement_ids: list[str]
) -> tuple[str, list[str]]:
    body = current_body or ""
    applied: list[str] = []
    for req_id in missing_requirement_ids:
        scaffold = SCAFFOLDS.get(req_id)
        if scaffold is None:
            continue
        if _heading_present(body, _heading_of(scaffold)):
            continue
        separator = "" if body == "" else ("\n" if body.endswith("\n") else "\n\n")
        body = f"{body}{separator}{scaffold}"
        applied.append(req_id)
    return body, applied
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd backend && python -m pytest tests/test_scaffold.py -v`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add backend/app/triage/__init__.py backend/app/triage/scaffold.py backend/tests/test_scaffold.py
git commit -m "feat: deterministic scaffold engine for missing issue sections"
```

---

### Task 3: Structured diff (`app/triage/diff.py`)

**Files:**
- Create: `backend/app/triage/diff.py`
- Test: `backend/tests/test_diff.py`

**Interfaces:**
- Produces: `build_diff(base: str, proposed: str) -> list[dict[str, str]]` — whole-body diff via `difflib.Differ`, each entry `{"op": "context"|"add"|"del", "line": str}`, intraline `?` hint lines dropped.

- [ ] **Step 1: Write the failing test**

Create `backend/tests/test_diff.py`:

```python
from app.triage.diff import build_diff


def test_pure_append_is_all_add_and_context():
    ops = build_diff("line one", "line one\nline two")
    assert {"op": "context", "line": "line one"} in ops
    assert {"op": "add", "line": "line two"} in ops
    assert all(o["op"] != "del" for o in ops)


def test_removed_line_is_del():
    ops = build_diff("keep\ndrop", "keep")
    assert {"op": "del", "line": "drop"} in ops


def test_no_change_is_all_context():
    ops = build_diff("a\nb", "a\nb")
    assert ops == [{"op": "context", "line": "a"}, {"op": "context", "line": "b"}]


def test_markdown_hr_line_is_not_mistaken_for_header():
    # A literal "---" line must survive as content, not be swallowed as a diff header.
    ops = build_diff("---", "---\n## New")
    assert {"op": "context", "line": "---"} in ops
    assert {"op": "add", "line": "## New"} in ops
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && python -m pytest tests/test_diff.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'app.triage.diff'`.

- [ ] **Step 3: Write the implementation**

Create `backend/app/triage/diff.py`:

```python
import difflib

# difflib.Differ tags each line with a 2-char code. Using Differ (not unified_diff)
# avoids any "---"/"+++" header ambiguity with markdown horizontal rules, and for
# short issue bodies showing full context is clearer than hunks.
_CODES = {"  ": "context", "+ ": "add", "- ": "del"}


def build_diff(base: str, proposed: str) -> list[dict[str, str]]:
    out: list[dict[str, str]] = []
    for line in difflib.Differ().compare(base.splitlines(), proposed.splitlines()):
        op = _CODES.get(line[:2])
        if op is None:  # "? " intraline hint lines
            continue
        out.append({"op": op, "line": line[2:]})
    return out
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd backend && python -m pytest tests/test_diff.py -v`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add backend/app/triage/diff.py backend/tests/test_diff.py
git commit -m "feat: structured difflib diff for suggestion previews"
```

---

### Task 4: GitHub write helpers (`github/client.py`)

**Files:**
- Modify: `backend/app/github/client.py` (append two helpers)
- Test: `backend/tests/test_github_write.py`

**Interfaces:**
- Consumes: `get_installation_token`, `_check_rate_limit`, `make_http_client` (existing).
- Produces:
  - `installation_get_one(client, installation_id, path) -> dict[str, Any]` — single authenticated GET.
  - `installation_patch(client, installation_id, path, json) -> dict[str, Any]` — authenticated PATCH.

- [ ] **Step 1: Write the failing test**

Create `backend/tests/test_github_write.py`:

```python
import httpx
import respx

from app.github.client import (
    installation_get_one,
    installation_patch,
    make_http_client,
)
from tests.test_github_auth import app_creds  # noqa: F401 - reused fixture


def _token_route():
    return respx.post("https://api.github.com/app/installations/42/access_tokens").mock(
        return_value=httpx.Response(
            201, json={"token": "ghs_test", "expires_at": "2099-01-01T00:00:00Z"}
        )
    )


@respx.mock
async def test_installation_get_one(app_creds):  # noqa: F811
    _token_route()
    respx.get("https://api.github.com/repos/o/r/issues/5").mock(
        return_value=httpx.Response(200, json={"number": 5, "body": "hi"})
    )
    async with make_http_client() as client:
        issue = await installation_get_one(client, 42, "/repos/o/r/issues/5")
    assert issue["body"] == "hi"


@respx.mock
async def test_installation_patch_sends_body(app_creds):  # noqa: F811
    _token_route()
    route = respx.patch("https://api.github.com/repos/o/r/issues/5").mock(
        return_value=httpx.Response(200, json={"number": 5, "body": "new"})
    )
    async with make_http_client() as client:
        updated = await installation_patch(
            client, 42, "/repos/o/r/issues/5", {"body": "new"}
        )
    assert updated["body"] == "new"
    assert route.calls.last.request.method == "PATCH"
    import json as _json

    assert _json.loads(route.calls.last.request.content)["body"] == "new"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && python -m pytest tests/test_github_write.py -v`
Expected: FAIL with `ImportError: cannot import name 'installation_get_one'`.

- [ ] **Step 3: Append the helpers**

Append to `backend/app/github/client.py` (after `installation_get_paginated`):

```python
async def installation_get_one(
    client: httpx.AsyncClient, installation_id: int, path: str
) -> dict[str, Any]:
    token = await get_installation_token(installation_id, client)
    resp = await client.get(path, headers={"Authorization": f"Bearer {token}"})
    _check_rate_limit(resp)
    resp.raise_for_status()
    return resp.json()


async def installation_patch(
    client: httpx.AsyncClient,
    installation_id: int,
    path: str,
    json: dict[str, Any],
) -> dict[str, Any]:
    token = await get_installation_token(installation_id, client)
    resp = await client.patch(
        path, json=json, headers={"Authorization": f"Bearer {token}"}
    )
    _check_rate_limit(resp)
    resp.raise_for_status()
    return resp.json()
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd backend && python -m pytest tests/test_github_write.py -v`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add backend/app/github/client.py backend/tests/test_github_write.py
git commit -m "feat: authenticated GitHub GET-one and PATCH helpers"
```

---

### Task 5: Triage service + inbox endpoint

**Files:**
- Create: `backend/app/triage/service.py`
- Create: `backend/app/routers/triage.py`
- Modify: `backend/app/main.py` (register router)
- Test: `backend/tests/test_api_triage.py`

**Interfaces:**
- Consumes: `build_proposed_body` (Task 2), `build_diff` (Task 3), `RUBRICS` (readiness), models `Issue/IssueClassification/IssueReadiness/IssueSuggestion/Repository`.
- Produces (this task only — later tasks append to the same files):
  - service: `missing_requirements(issue_type: str, factors: list[dict]) -> list[dict[str, str]]`; `async inbox(session, repo_id, issue_type, threshold, limit, offset) -> tuple[list[dict], int]`.
  - router: `GET /triage/inbox` → `InboxPage`.

- [ ] **Step 1: Write the failing test**

Create `backend/tests/test_api_triage.py` (reuses the issues seed helpers):

```python
import pytest
from httpx import ASGITransport, AsyncClient

from app.main import app
from tests.test_api_issues import (
    seed_classifications,
    seed_issues,
    seed_readiness,
)


@pytest.fixture
def api():
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test")


async def get_body(api, url):
    resp = await api.get(url)
    assert resp.status_code == 200, resp.text
    return resp.json()


async def test_inbox_lists_scored_below_threshold_worst_first(clean_db, api):
    await seed_issues()
    await seed_classifications()
    await seed_readiness()  # issue 1 => 42 (bug), issue 4 => 88 (feature)
    body = await get_body(api, "/triage/inbox?threshold=80")
    assert body["total"] == 1
    item = body["items"][0]
    assert item["title"] == "Alpha bug"
    assert item["readiness_score"] == 42
    assert item["issue_type"] == "bug"
    assert item["suggestion_status"] is None


async def test_inbox_missing_chips_come_from_absent_factors(clean_db, api):
    await seed_issues()
    await seed_classifications()
    await seed_readiness()
    body = await get_body(api, "/triage/inbox")
    labels = [m["label"] for m in body["items"][0]["missing"]]
    assert "Reproduction steps" in labels          # present:false in seed
    assert "Problem statement" not in labels        # present:true in seed


async def test_inbox_threshold_widens_result(clean_db, api):
    await seed_issues()
    await seed_classifications()
    await seed_readiness()
    body = await get_body(api, "/triage/inbox?threshold=100")
    assert [i["title"] for i in body["items"]] == ["Alpha bug", "Delta task"]  # 42, 88 asc


async def test_inbox_type_and_repo_filters(clean_db, api):
    await seed_issues()
    await seed_classifications()
    await seed_readiness()
    body = await get_body(api, "/triage/inbox?threshold=100&type=feature")
    assert [i["title"] for i in body["items"]] == ["Delta task"]
    scoped = await get_body(api, "/triage/inbox?threshold=100&repo_id=501")
    assert [i["title"] for i in scoped["items"]] == ["Delta task"]


async def test_inbox_excludes_unscored_and_unclassified(clean_db, api):
    await seed_issues()
    await seed_classifications()  # classified: 1, 4 ; but no readiness yet
    body = await get_body(api, "/triage/inbox?threshold=100")
    assert body["total"] == 0  # inner join on readiness excludes them
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && python -m pytest tests/test_api_triage.py -v`
Expected: FAIL (404s / no `/triage/inbox` route).

- [ ] **Step 3: Create the service (inbox portion)**

Create `backend/app/triage/service.py`:

```python
from typing import Any

from sqlalchemy import Select, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.llm.readiness import RUBRICS
from app.models import (
    Issue,
    IssueClassification,
    IssueReadiness,
    IssueSuggestion,
    Repository,
)


def missing_requirements(issue_type: str, factors: list[dict]) -> list[dict[str, str]]:
    """Rubric requirements the readiness score marked absent, as [{id, label}]."""
    rubric = RUBRICS[issue_type]
    present_by_label = {f["requirement"]: f["present"] for f in factors}
    return [
        {"id": r.id, "label": r.label}
        for r in rubric
        if not present_by_label.get(r.label, False)
    ]


def _inbox_query(repo_id: int | None, issue_type: str | None, threshold: int) -> Select:
    query = (
        select(
            Issue, Repository.full_name, IssueClassification, IssueReadiness, IssueSuggestion
        )
        .join(Repository, Issue.repository_id == Repository.id)
        .join(IssueClassification, IssueClassification.issue_id == Issue.id)
        .join(IssueReadiness, IssueReadiness.issue_id == Issue.id)
        .outerjoin(IssueSuggestion, IssueSuggestion.issue_id == Issue.id)
        .where(Issue.is_pull_request.is_(False), IssueReadiness.score < threshold)
    )
    if repo_id is not None:
        query = query.where(Issue.repository_id == repo_id)
    if issue_type:
        query = query.where(IssueClassification.issue_type == issue_type)
    return query


async def inbox(
    session: AsyncSession,
    repo_id: int | None,
    issue_type: str | None,
    threshold: int,
    limit: int,
    offset: int,
) -> tuple[list[dict[str, Any]], int]:
    query = _inbox_query(repo_id, issue_type, threshold)
    total = (
        await session.execute(select(func.count()).select_from(query.subquery()))
    ).scalar_one()
    ordered = query.order_by(IssueReadiness.score.asc(), Issue.id)
    rows = (await session.execute(ordered.limit(limit).offset(offset))).all()
    items = [
        {
            "id": issue.id,
            "number": issue.number,
            "title": issue.title,
            "repo_full_name": full_name,
            "issue_type": classification.issue_type,
            "component": classification.component,
            "readiness_score": readiness.score,
            "missing": missing_requirements(readiness.issue_type, readiness.factors),
            "suggestion_status": suggestion.status if suggestion else None,
        }
        for issue, full_name, classification, readiness, suggestion in rows
    ]
    return items, total
```

- [ ] **Step 4: Create the router (inbox endpoint)**

Create `backend/app/routers/triage.py`:

```python
from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

from app.db import get_session
from app.triage import service

router = APIRouter(tags=["triage"])


class MissingItem(BaseModel):
    id: str
    label: str


class InboxItem(BaseModel):
    id: int
    number: int
    title: str
    repo_full_name: str
    issue_type: str
    component: str | None
    readiness_score: int
    missing: list[MissingItem]
    suggestion_status: str | None


class InboxPage(BaseModel):
    items: list[InboxItem]
    total: int
    limit: int
    offset: int


@router.get("/triage/inbox", response_model=InboxPage)
async def triage_inbox(
    session: AsyncSession = Depends(get_session),
    repo_id: int | None = None,
    issue_type: str | None = Query(None, alias="type"),
    threshold: int = Query(80, ge=1, le=100),
    limit: int = Query(50, ge=1, le=100),
    offset: int = Query(0, ge=0),
) -> InboxPage:
    items, total = await service.inbox(
        session, repo_id, issue_type, threshold, limit, offset
    )
    return InboxPage(items=items, total=total, limit=limit, offset=offset)
```

- [ ] **Step 5: Register the router**

In `backend/app/main.py`, add the import and `include_router` alongside the others:

```python
from app.routers.triage import router as triage_router
```
```python
app.include_router(triage_router)
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `cd backend && python -m pytest tests/test_api_triage.py -v`
Expected: PASS (5 tests).

- [ ] **Step 7: Commit**

```bash
git add backend/app/triage/service.py backend/app/routers/triage.py backend/app/main.py backend/tests/test_api_triage.py
git commit -m "feat: triage inbox endpoint (needs-detail queue with derived chips)"
```

---

### Task 6: Suggestion generate / get / update endpoints

**Files:**
- Modify: `backend/app/triage/service.py` (append suggestion functions + exceptions)
- Modify: `backend/app/routers/triage.py` (append `SuggestionOut` + 3 endpoints)
- Test: `backend/tests/test_api_triage.py` (append)

**Interfaces:**
- Consumes: `build_proposed_body`, `build_diff`, `missing_requirements` (Task 5).
- Produces:
  - service exceptions `IssueNotFound`, `ReadinessRequired`, `SuggestionNotFound`, `SuggestionConflict` (all `Exception` subclasses).
  - `async generate_suggestion(session, issue_id) -> IssueSuggestion`
  - `async get_suggestion(session, issue_id) -> IssueSuggestion | None`
  - `async update_suggestion(session, issue_id, proposed_body: str | None, status: str | None) -> IssueSuggestion`
  - router `SuggestionOut` (fields: `issue_id, status, base_body, proposed_body, missing_requirements, edited, diff, pushed_at`); endpoints `POST/GET/PATCH /issues/{id}/suggestion`.

- [ ] **Step 1: Write the failing tests**

Append to `backend/tests/test_api_triage.py`:

```python
async def test_generate_requires_readiness(clean_db, api):
    await seed_issues()
    await seed_classifications()  # classified but not scored
    resp = await api.post("/issues/1/suggestion")
    assert resp.status_code == 409


async def test_generate_missing_issue_404(clean_db, api):
    resp = await api.post("/issues/999/suggestion")
    assert resp.status_code == 404


async def test_generate_then_get_produces_scaffold_and_diff(clean_db, api):
    await seed_issues()
    await seed_classifications()
    await seed_readiness()
    resp = await api.post("/issues/1/suggestion")
    assert resp.status_code == 200
    data = resp.json()
    assert data["status"] == "draft"
    assert data["edited"] is False
    assert "## Reproduction Steps" in data["proposed_body"]
    assert any(o["op"] == "add" for o in data["diff"])
    assert {"id": "repro_steps", "label": "Reproduction steps"} in data["missing_requirements"]
    # reload
    got = await get_body(api, "/issues/1/suggestion")
    assert got["proposed_body"] == data["proposed_body"]


async def test_get_404_when_absent(clean_db, api):
    await seed_issues()
    await seed_readiness()
    resp = await api.get("/issues/1/suggestion")
    assert resp.status_code == 404


async def test_edit_sets_edited_and_rediffs(clean_db, api):
    await seed_issues()
    await seed_classifications()
    await seed_readiness()
    await api.post("/issues/1/suggestion")
    resp = await api.patch("/issues/1/suggestion", json={"proposed_body": "totally new body"})
    assert resp.status_code == 200
    data = resp.json()
    assert data["edited"] is True
    assert data["proposed_body"] == "totally new body"
    assert any(o["op"] == "add" and o["line"] == "totally new body" for o in data["diff"])


async def test_save_as_suggestion_and_reject(clean_db, api):
    await seed_issues()
    await seed_classifications()
    await seed_readiness()
    await api.post("/issues/1/suggestion")
    saved = await api.patch("/issues/1/suggestion", json={"status": "suggested"})
    assert saved.json()["status"] == "suggested"
    rejected = await api.patch("/issues/1/suggestion", json={"status": "rejected"})
    assert rejected.json()["status"] == "rejected"


async def test_regenerate_replaces_row_and_resets_edited(clean_db, api):
    await seed_issues()
    await seed_classifications()
    await seed_readiness()
    await api.post("/issues/1/suggestion")
    await api.patch("/issues/1/suggestion", json={"proposed_body": "edited"})
    regen = await api.post("/issues/1/suggestion")
    assert regen.json()["edited"] is False
    assert "## Reproduction Steps" in regen.json()["proposed_body"]


async def test_bad_status_is_422(clean_db, api):
    await seed_issues()
    await seed_readiness()
    resp = await api.patch("/issues/1/suggestion", json={"status": "pushed"})
    assert resp.status_code == 422  # Literal rejects 'pushed'
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend && python -m pytest tests/test_api_triage.py -k "generate or edit or save or regenerate or get_404 or bad_status" -v`
Expected: FAIL (routes 404).

- [ ] **Step 3: Append suggestion functions to the service**

Append to `backend/app/triage/service.py` (add imports at top: `from sqlalchemy.dialects.postgresql import insert as pg_insert`, and `from app.triage.scaffold import build_proposed_body`):

```python
class IssueNotFound(Exception):
    pass


class ReadinessRequired(Exception):
    pass


class SuggestionNotFound(Exception):
    pass


class SuggestionConflict(Exception):
    pass


async def get_suggestion(
    session: AsyncSession, issue_id: int
) -> IssueSuggestion | None:
    return (
        await session.execute(
            select(IssueSuggestion).where(IssueSuggestion.issue_id == issue_id)
        )
    ).scalar_one_or_none()


async def generate_suggestion(session: AsyncSession, issue_id: int) -> IssueSuggestion:
    row = (
        await session.execute(
            select(Issue, IssueReadiness)
            .join(IssueReadiness, IssueReadiness.issue_id == Issue.id)
            .where(Issue.id == issue_id)
        )
    ).first()
    if row is None:
        exists = (
            await session.execute(select(Issue.id).where(Issue.id == issue_id))
        ).scalar_one_or_none()
        if exists is None:
            raise IssueNotFound()
        raise ReadinessRequired()
    issue, readiness = row
    missing = missing_requirements(readiness.issue_type, readiness.factors)
    proposed, _applied = build_proposed_body(
        issue.body or "", [m["id"] for m in missing]
    )
    values = {
        "issue_id": issue_id,
        "status": "draft",
        "base_body": issue.body or "",
        "base_gh_updated_at": issue.gh_updated_at,
        "proposed_body": proposed,
        "missing_requirements": missing,
        "edited": False,
        "updated_at": func.now(),
        "pushed_at": None,
    }
    await session.execute(
        pg_insert(IssueSuggestion)
        .values(**values)
        .on_conflict_do_update(
            index_elements=["issue_id"],
            set_={k: v for k, v in values.items() if k != "issue_id"},
        )
    )
    await session.commit()
    sug = await get_suggestion(session, issue_id)
    assert sug is not None
    return sug


async def update_suggestion(
    session: AsyncSession,
    issue_id: int,
    proposed_body: str | None,
    status: str | None,
) -> IssueSuggestion:
    sug = await get_suggestion(session, issue_id)
    if sug is None:
        raise SuggestionNotFound()
    if sug.status == "pushed":
        raise SuggestionConflict("suggestion has already been pushed")
    if proposed_body is not None:
        sug.proposed_body = proposed_body
        sug.edited = True
    if status is not None:
        sug.status = status
    await session.commit()
    await session.refresh(sug)
    return sug
```

- [ ] **Step 4: Append the endpoints to the router**

Append to `backend/app/routers/triage.py` (add imports: `from datetime import datetime`, `from typing import Literal`, `from fastapi import HTTPException`, `from app.triage.diff import build_diff`, `from app.models import IssueSuggestion`):

```python
class SuggestionOut(BaseModel):
    issue_id: int
    status: str
    base_body: str
    proposed_body: str
    missing_requirements: list[MissingItem]
    edited: bool
    diff: list[dict]
    pushed_at: datetime | None


class SuggestionPatch(BaseModel):
    proposed_body: str | None = None
    status: Literal["suggested", "rejected"] | None = None


def _to_out(sug: IssueSuggestion) -> SuggestionOut:
    return SuggestionOut(
        issue_id=sug.issue_id,
        status=sug.status,
        base_body=sug.base_body,
        proposed_body=sug.proposed_body,
        missing_requirements=sug.missing_requirements,
        edited=sug.edited,
        diff=build_diff(sug.base_body, sug.proposed_body),
        pushed_at=sug.pushed_at,
    )


@router.post("/issues/{issue_id}/suggestion", response_model=SuggestionOut)
async def generate(
    issue_id: int, session: AsyncSession = Depends(get_session)
) -> SuggestionOut:
    try:
        sug = await service.generate_suggestion(session, issue_id)
    except service.IssueNotFound:
        raise HTTPException(status_code=404, detail="Issue not found")
    except service.ReadinessRequired:
        raise HTTPException(
            status_code=409, detail="Score the issue's readiness before suggesting fixes"
        )
    return _to_out(sug)


@router.get("/issues/{issue_id}/suggestion", response_model=SuggestionOut)
async def get_one(
    issue_id: int, session: AsyncSession = Depends(get_session)
) -> SuggestionOut:
    sug = await service.get_suggestion(session, issue_id)
    if sug is None:
        raise HTTPException(status_code=404, detail="No suggestion for this issue")
    return _to_out(sug)


@router.patch("/issues/{issue_id}/suggestion", response_model=SuggestionOut)
async def update(
    issue_id: int,
    patch: SuggestionPatch,
    session: AsyncSession = Depends(get_session),
) -> SuggestionOut:
    try:
        sug = await service.update_suggestion(
            session, issue_id, patch.proposed_body, patch.status
        )
    except service.SuggestionNotFound:
        raise HTTPException(status_code=404, detail="No suggestion for this issue")
    except service.SuggestionConflict as exc:
        raise HTTPException(status_code=409, detail=str(exc))
    return _to_out(sug)
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd backend && python -m pytest tests/test_api_triage.py -v`
Expected: PASS (all inbox + suggestion tests).

- [ ] **Step 6: Commit**

```bash
git add backend/app/triage/service.py backend/app/routers/triage.py backend/tests/test_api_triage.py
git commit -m "feat: generate/get/update issue suggestion endpoints with diff"
```

---

### Task 7: Approve & push endpoint (write-safety + re-score)

**Files:**
- Modify: `backend/app/triage/service.py` (append `GitHubWriteError`, `_enqueue_rescore`, `push_suggestion`)
- Modify: `backend/app/routers/triage.py` (append push endpoint)
- Test: `backend/tests/test_api_triage.py` (append push tests)

**Interfaces:**
- Consumes: `installation_get_one`, `installation_patch`, `make_http_client` (Task 4); `get_arq_pool` (`app.queue`); `_parse_ts` (`app.github.sync`).
- Produces:
  - service `GitHubWriteError(Exception)`; `async push_suggestion(session, issue_id) -> IssueSuggestion`.
  - router `POST /issues/{id}/suggestion/push` → `SuggestionOut`.

- [ ] **Step 1: Write the failing tests**

Append to `backend/tests/test_api_triage.py` (add imports at top of file: `import httpx`, `import respx`, `from tests.test_github_auth import app_creds  # noqa: F401`):

```python
def _push_seed_bodies():
    """Set issue 1's body so the readiness seed's base matches on re-fetch."""
    return "Auth fails after refresh."


async def _set_issue_body(body: str):
    from sqlalchemy import update

    from app.db import get_sessionmaker
    from app.models import Issue

    async with get_sessionmaker()() as session:
        await session.execute(update(Issue).where(Issue.id == 1).values(body=body))
        await session.commit()


class _FakePool:
    def __init__(self):
        self.jobs = []

    async def enqueue_job(self, *args, **kwargs):
        self.jobs.append((args, kwargs))
        return object()


def _token_route():
    return respx.post("https://api.github.com/app/installations/42/access_tokens").mock(
        return_value=httpx.Response(
            201, json={"token": "ghs_test", "expires_at": "2099-01-01T00:00:00Z"}
        )
    )


@respx.mock
async def test_push_writes_body_updates_local_and_enqueues(clean_db, api, app_creds, monkeypatch):  # noqa: F811
    await seed_issues()
    await _set_issue_body("Auth fails after refresh.")
    await seed_classifications()
    await seed_readiness()
    await api.post("/issues/1/suggestion")

    fake_pool = _FakePool()

    async def fake_get_pool():
        return fake_pool

    from app.triage import service

    monkeypatch.setattr(service, "get_arq_pool", fake_get_pool)

    _token_route()
    respx.get("https://api.github.com/repos/patelmj/mehova/issues/1").mock(
        return_value=httpx.Response(200, json={"number": 1, "body": "Auth fails after refresh."})
    )
    patch_route = respx.patch("https://api.github.com/repos/patelmj/mehova/issues/1").mock(
        return_value=httpx.Response(
            200, json={"number": 1, "body": "PUSHED", "updated_at": "2026-07-20T12:00:00Z"}
        )
    )

    resp = await api.post("/issues/1/suggestion/push")
    assert resp.status_code == 200, resp.text
    assert resp.json()["status"] == "pushed"
    assert patch_route.called
    # re-score enqueued via the classify dedupe key
    assert fake_pool.jobs == [
        (("classify_repository", 500), {"_job_id": "classify-500"})
    ]
    # local issue body updated from the PATCH response
    reloaded = await get_body(api, "/issues/1/suggestion")
    assert reloaded["status"] == "pushed"


@respx.mock
async def test_push_write_safety_409_when_github_body_changed(clean_db, api, app_creds, monkeypatch):  # noqa: F811
    await seed_issues()
    await _set_issue_body("Auth fails after refresh.")
    await seed_classifications()
    await seed_readiness()
    await api.post("/issues/1/suggestion")

    _token_route()
    respx.get("https://api.github.com/repos/patelmj/mehova/issues/1").mock(
        return_value=httpx.Response(200, json={"number": 1, "body": "SOMEONE ELSE EDITED THIS"})
    )
    resp = await api.post("/issues/1/suggestion/push")
    assert resp.status_code == 409
    assert "changed on GitHub" in resp.json()["detail"]


@respx.mock
async def test_push_502_when_github_forbids(clean_db, api, app_creds, monkeypatch):  # noqa: F811
    await seed_issues()
    await _set_issue_body("Auth fails after refresh.")
    await seed_classifications()
    await seed_readiness()
    await api.post("/issues/1/suggestion")

    _token_route()
    respx.get("https://api.github.com/repos/patelmj/mehova/issues/1").mock(
        return_value=httpx.Response(200, json={"number": 1, "body": "Auth fails after refresh."})
    )
    respx.patch("https://api.github.com/repos/patelmj/mehova/issues/1").mock(
        return_value=httpx.Response(403, json={"message": "Resource not accessible by integration"})
    )
    resp = await api.post("/issues/1/suggestion/push")
    assert resp.status_code == 502


async def test_push_404_when_no_suggestion(clean_db, api):
    await seed_issues()
    resp = await api.post("/issues/1/suggestion/push")
    assert resp.status_code == 404
```

> **Note on the seed body:** `seed_issues()` creates issue 1 with `body=None`. `_set_issue_body("Auth fails after refresh.")` gives it a real body so `base_body` (snapshot at generate) equals what the mocked GitHub GET returns, letting the happy-path safety check pass. The 409 test returns a *different* body from GitHub.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend && python -m pytest tests/test_api_triage.py -k push -v`
Expected: FAIL (no push route).

- [ ] **Step 3: Append push logic to the service**

Add imports at the top of `backend/app/triage/service.py`:

```python
import httpx

from app.github.client import installation_get_one, installation_patch, make_http_client
from app.github.sync import _parse_ts
from app.queue import get_arq_pool
```

Append:

```python
class GitHubWriteError(Exception):
    pass


async def _enqueue_rescore(repo_id: int) -> None:
    pool = await get_arq_pool()
    await pool.enqueue_job(
        "classify_repository", repo_id, _job_id=f"classify-{repo_id}"
    )


async def push_suggestion(session: AsyncSession, issue_id: int) -> IssueSuggestion:
    row = (
        await session.execute(
            select(IssueSuggestion, Issue, Repository)
            .join(Issue, Issue.id == IssueSuggestion.issue_id)
            .join(Repository, Repository.id == Issue.repository_id)
            .where(IssueSuggestion.issue_id == issue_id)
        )
    ).first()
    if row is None:
        raise SuggestionNotFound()
    sug, issue, repo = row
    if sug.status in ("pushed", "rejected"):
        raise SuggestionConflict(f"suggestion is {sug.status}")

    path = f"/repos/{repo.full_name}/issues/{issue.number}"
    async with make_http_client() as client:
        live = await installation_get_one(client, repo.installation_id, path)
        if (live.get("body") or "") != sug.base_body:
            raise SuggestionConflict(
                "issue changed on GitHub since this suggestion was generated; regenerate"
            )
        try:
            updated = await installation_patch(
                client, repo.installation_id, path, {"body": sug.proposed_body}
            )
        except httpx.HTTPStatusError as exc:
            raise GitHubWriteError(
                f"GitHub rejected the update (HTTP {exc.response.status_code}); "
                "ensure the App has Issues: write permission"
            ) from exc

    issue.body = updated.get("body") or sug.proposed_body
    updated_at = _parse_ts(updated.get("updated_at"))
    if updated_at is not None:
        issue.gh_updated_at = updated_at
    sug.status = "pushed"
    sug.pushed_at = func.now()
    await session.commit()
    await _enqueue_rescore(issue.repository_id)
    await session.refresh(sug)
    return sug
```

- [ ] **Step 4: Append the push endpoint to the router**

Append to `backend/app/routers/triage.py`:

```python
@router.post("/issues/{issue_id}/suggestion/push", response_model=SuggestionOut)
async def push(
    issue_id: int, session: AsyncSession = Depends(get_session)
) -> SuggestionOut:
    try:
        sug = await service.push_suggestion(session, issue_id)
    except service.SuggestionNotFound:
        raise HTTPException(status_code=404, detail="No suggestion for this issue")
    except service.SuggestionConflict as exc:
        raise HTTPException(status_code=409, detail=str(exc))
    except service.GitHubWriteError as exc:
        raise HTTPException(status_code=502, detail=str(exc))
    return _to_out(sug)
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd backend && python -m pytest tests/test_api_triage.py -v`
Expected: PASS (all triage tests, including push).

- [ ] **Step 6: Run the full backend suite + lint**

Run: `cd backend && python -m pytest -q && ruff check app tests`
Expected: PASS, no lint errors. (Full suite ~2.5 min.)

- [ ] **Step 7: Commit**

```bash
git add backend/app/triage/service.py backend/app/routers/triage.py backend/tests/test_api_triage.py
git commit -m "feat: approve and push suggestion to GitHub with write-safety and re-score"
```

---

### Task 8: Frontend inbox page + toolbar

**Files:**
- Modify: `frontend/src/app/triage/page.tsx`
- Create: `frontend/src/app/triage/triage-client.tsx`
- Create: `frontend/src/app/triage/triage-toolbar.tsx`

**Interfaces:**
- Consumes: `getJson` (`lib/api`), `GET /api/backend/triage/inbox`, `/api/backend/repositories`.
- Produces: `TriageClient` (default export of the client module) rendering the inbox table; row action buttons keyed by `suggestion_status` (`Suggest fixes` when null, `View suggestion` otherwise); an `expandedId` slot that Task 9 fills with `SuggestionDrawer`.

- [ ] **Step 1: Replace the placeholder page**

Overwrite `frontend/src/app/triage/page.tsx`:

```tsx
import { TriageClient } from "./triage-client";

export default function TriagePage() {
  return <TriageClient />;
}
```

- [ ] **Step 2: Create the toolbar**

Create `frontend/src/app/triage/triage-toolbar.tsx`:

```tsx
"use client";

import { useQuery } from "@tanstack/react-query";
import { getJson } from "../../lib/api";

type Repo = { id: number; full_name: string };

const control =
  "rounded-lg border border-(--color-border) bg-(--color-surface) px-2 py-1.5 transition-all duration-150";

const TYPES = ["bug", "feature", "debt", "question", "docs"];

const THRESHOLDS = [
  { value: "90", label: "Readiness < 90%" },
  { value: "80", label: "Readiness < 80%" },
  { value: "60", label: "Readiness < 60%" },
  { value: "40", label: "Readiness < 40%" },
];

export type TriageParams = {
  repoId: string | null;
  type: string | null;
  threshold: string;
  setParams: (updates: Record<string, string | null>) => void;
};

export function TriageToolbar({ params }: { params: TriageParams }) {
  const { repoId, type, threshold, setParams } = params;
  const { data: repos } = useQuery({
    queryKey: ["repositories"],
    queryFn: () => getJson<Repo[]>("/api/backend/repositories"),
  });

  return (
    <div className="flex flex-wrap items-center gap-2">
      <select
        aria-label="Repository"
        className={control}
        value={repoId ?? ""}
        onChange={(e) =>
          setParams({ repo_id: e.target.value || null, offset: null })
        }
      >
        <option value="">All repositories</option>
        {(repos ?? []).map((repo) => (
          <option key={repo.id} value={String(repo.id)}>
            {repo.full_name}
          </option>
        ))}
      </select>

      <select
        aria-label="Type"
        className={control}
        value={type ?? ""}
        onChange={(e) => setParams({ type: e.target.value || null, offset: null })}
      >
        <option value="">Any type</option>
        {TYPES.map((t) => (
          <option key={t} value={t}>
            {t}
          </option>
        ))}
      </select>

      <select
        aria-label="Threshold"
        className={control}
        value={threshold}
        onChange={(e) => setParams({ threshold: e.target.value, offset: null })}
      >
        {THRESHOLDS.map((t) => (
          <option key={t.value} value={t.value}>
            {t.label}
          </option>
        ))}
      </select>
    </div>
  );
}
```

- [ ] **Step 3: Create the inbox client**

Create `frontend/src/app/triage/triage-client.tsx`:

```tsx
"use client";

import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useRouter, useSearchParams } from "next/navigation";
import { Fragment, useCallback, useState } from "react";
import { getJson } from "../../lib/api";
import { SuggestionDrawer } from "./suggestion-drawer";
import { TriageToolbar } from "./triage-toolbar";

export type MissingItem = { id: string; label: string };

export type InboxItem = {
  id: number;
  number: number;
  title: string;
  repo_full_name: string;
  issue_type: string;
  component: string | null;
  readiness_score: number;
  missing: MissingItem[];
  suggestion_status: string | null;
};

type InboxPage = {
  items: InboxItem[];
  total: number;
  limit: number;
  offset: number;
};

const LIMIT = 50;
const card =
  "rounded-[14px] border border-(--color-border) bg-(--color-surface) shadow-(--shadow-card)";
const chip =
  "rounded-full border border-(--type-bug) px-1.5 text-[10px] text-(--type-bug)";
const btn =
  "rounded-lg border border-(--color-border) bg-(--color-surface) px-2.5 py-1.5 text-(--color-primary) transition-all duration-150 hover:bg-(--accent-tint)";

function readinessTone(score: number): string {
  if (score < 40) return "text-(--type-bug)";
  if (score < 75) return "text-(--type-debt)";
  return "text-(--type-feature)";
}

const STATUS_BADGE: Record<string, string> = {
  draft: "text-(--color-text-muted)",
  suggested: "text-(--type-feature)",
  pushed: "text-(--type-feature)",
  rejected: "text-(--color-text-muted)",
};

export function TriageClient() {
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
      router.replace(qs ? `/triage?${qs}` : "/triage", { scroll: false });
    },
    [router, searchParams],
  );

  const repoId = searchParams.get("repo_id");
  const type = searchParams.get("type");
  const threshold = searchParams.get("threshold") ?? "80";
  const offset = Math.max(0, Number(searchParams.get("offset") ?? "0") || 0);

  const backendQuery = new URLSearchParams({
    threshold,
    limit: String(LIMIT),
    offset: String(offset),
  });
  if (repoId) backendQuery.set("repo_id", repoId);
  if (type) backendQuery.set("type", type);

  const { data, error, isPending } = useQuery({
    queryKey: ["triage-inbox", backendQuery.toString()],
    queryFn: () => getJson<InboxPage>(`/api/backend/triage/inbox?${backendQuery}`),
    placeholderData: keepPreviousData,
  });

  const [expandedId, setExpandedId] = useState<number | null>(null);

  return (
    <div className="flex flex-col gap-4" data-testid="triage-content">
      <div className="flex items-baseline gap-3">
        <h1 className="text-lg font-semibold tracking-[-0.01em]">Triage</h1>
        <span className="text-(--color-text-muted)">
          Issues that need detail before work can start
        </span>
      </div>

      <TriageToolbar params={{ repoId, type, threshold, setParams }} />

      {isPending ? (
        <div className={`${card} px-6 py-16 text-center text-(--color-text-muted)`}>
          Loading triage inbox…
        </div>
      ) : error ? (
        <div className={`${card} px-6 py-16 text-center`}>
          <div className="text-sm font-medium">Backend unavailable</div>
          <div className="pt-1.5 text-(--color-text-muted)">{error.message}</div>
        </div>
      ) : !data || data.total === 0 ? (
        <div className={`${card} flex flex-col items-center gap-1.5 px-6 py-16 text-center`}>
          <div className="text-sm font-medium">Nothing needs detail</div>
          <div className="max-w-md text-(--color-text-muted)">
            Every scored issue is above the readiness threshold. Lower the threshold
            to review more.
          </div>
        </div>
      ) : (
        <div className={`${card} divide-y divide-(--color-border)`}>
          {data.items.map((item) => (
            <Fragment key={item.id}>
              <div className="flex flex-col gap-1.5 px-4 py-3" data-testid="triage-row">
                <div className="flex items-center gap-3">
                  <span
                    className={`tabular-nums text-sm font-semibold ${readinessTone(item.readiness_score)}`}
                  >
                    {item.readiness_score}%
                  </span>
                  <span className="font-medium">
                    #{item.number} {item.title}
                  </span>
                  <span className="text-[11px] text-(--color-text-muted) uppercase">
                    {item.issue_type}
                    {item.component ? ` · ${item.component}` : ""}
                  </span>
                  {item.suggestion_status ? (
                    <span
                      className={`text-[11px] ${STATUS_BADGE[item.suggestion_status] ?? ""}`}
                      data-testid="row-status"
                    >
                      {item.suggestion_status}
                    </span>
                  ) : null}
                </div>
                {item.missing.length > 0 ? (
                  <div
                    className="flex flex-wrap items-center gap-1.5"
                    data-testid="missing-chips"
                  >
                    <span className="text-[11px] text-(--color-text-muted)">Missing:</span>
                    {item.missing.map((m) => (
                      <span key={m.id} className={chip}>
                        {m.label}
                      </span>
                    ))}
                  </div>
                ) : null}
                <div className="flex items-center gap-2 pt-1">
                  <button
                    type="button"
                    className={btn}
                    onClick={() =>
                      setExpandedId(expandedId === item.id ? null : item.id)
                    }
                    aria-expanded={expandedId === item.id}
                  >
                    {item.suggestion_status ? "View suggestion" : "Suggest fixes"}
                  </button>
                  <a
                    className={btn}
                    href={`https://github.com/${item.repo_full_name}/issues/${item.number}`}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    Open in GitHub
                  </a>
                </div>
              </div>
              {expandedId === item.id ? (
                <div className="bg-(--accent-tint) px-4 py-3">
                  <SuggestionDrawer
                    issueId={item.id}
                    hasExisting={item.suggestion_status !== null}
                    onClose={() => setExpandedId(null)}
                  />
                </div>
              ) : null}
            </Fragment>
          ))}
        </div>
      )}
    </div>
  );
}
```

> `SuggestionDrawer` does not exist yet — this file won't type-check until Task 9. That's expected; the two tasks ship together but are committed separately for reviewability. Do NOT run `npm run lint` between Task 8 and Task 9.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/app/triage/page.tsx frontend/src/app/triage/triage-client.tsx frontend/src/app/triage/triage-toolbar.tsx
git commit -m "feat: triage inbox page and toolbar (queue with missing-detail chips)"
```

---

### Task 9: Frontend suggestion drawer + `sendJson` helper

**Files:**
- Modify: `frontend/src/lib/api.ts` (add `sendJson`)
- Create: `frontend/src/app/triage/suggestion-drawer.tsx`

**Interfaces:**
- Consumes: `getJson`, new `sendJson`; endpoints `POST/GET/PATCH /issues/{id}/suggestion`, `POST /issues/{id}/suggestion/push`.
- Produces: `SuggestionDrawer({ issueId, hasExisting, onClose })` — generates-or-loads the suggestion, renders the diff + an editable textarea, and the actions Save / Save-as-suggestion / Approve&push / Reject / Regenerate.

- [ ] **Step 1: Add the mutation helper**

Append to `frontend/src/lib/api.ts`:

```ts
export async function sendJson<T>(
  url: string,
  method: "POST" | "PATCH" | "DELETE",
  body?: unknown,
): Promise<T> {
  return getJson<T>(url, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
```

- [ ] **Step 2: Create the drawer**

Create `frontend/src/app/triage/suggestion-drawer.tsx`:

```tsx
"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { getJson, sendJson } from "../../lib/api";

type DiffOp = { op: "context" | "add" | "del"; line: string };
type Suggestion = {
  issue_id: number;
  status: string;
  base_body: string;
  proposed_body: string;
  missing_requirements: { id: string; label: string }[];
  edited: boolean;
  diff: DiffOp[];
  pushed_at: string | null;
};

const base = "/api/backend/issues";
const btn =
  "rounded-lg border border-(--color-border) bg-(--color-surface) px-2.5 py-1.5 transition-all duration-150 hover:bg-(--accent-tint) disabled:text-(--color-text-muted)";

function diffLineClass(op: DiffOp["op"]): string {
  if (op === "add") return "text-(--type-feature)";
  if (op === "del") return "text-(--type-bug) line-through";
  return "text-(--color-text-muted)";
}
function diffPrefix(op: DiffOp["op"]): string {
  return op === "add" ? "+ " : op === "del" ? "- " : "  ";
}

export function SuggestionDrawer({
  issueId,
  hasExisting,
  onClose,
}: {
  issueId: number;
  hasExisting: boolean;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["suggestion", issueId] });
    qc.invalidateQueries({ queryKey: ["triage-inbox"] });
  };

  // Load an existing suggestion, or generate one on first open.
  const { data, error, isPending } = useQuery({
    queryKey: ["suggestion", issueId],
    queryFn: () =>
      hasExisting
        ? getJson<Suggestion>(`${base}/${issueId}/suggestion`)
        : sendJson<Suggestion>(`${base}/${issueId}/suggestion`, "POST"),
  });

  const [draft, setDraft] = useState<string | null>(null);
  const body = draft ?? data?.proposed_body ?? "";

  const save = useMutation({
    mutationFn: (proposed_body: string) =>
      sendJson<Suggestion>(`${base}/${issueId}/suggestion`, "PATCH", { proposed_body }),
    onSuccess: () => {
      setDraft(null);
      invalidate();
    },
  });
  const setStatus = useMutation({
    mutationFn: (status: "suggested" | "rejected") =>
      sendJson<Suggestion>(`${base}/${issueId}/suggestion`, "PATCH", { status }),
    onSuccess: (_res, status) => {
      invalidate();
      if (status === "rejected") onClose();
    },
  });
  const regenerate = useMutation({
    mutationFn: () => sendJson<Suggestion>(`${base}/${issueId}/suggestion`, "POST"),
    onSuccess: () => {
      setDraft(null);
      invalidate();
    },
  });
  const push = useMutation({
    mutationFn: () =>
      sendJson<Suggestion>(`${base}/${issueId}/suggestion/push`, "POST"),
    onSuccess: invalidate,
  });

  useEffect(() => {
    setDraft(null);
  }, [issueId]);

  if (isPending)
    return <div className="text-(--color-text-muted)">Preparing suggestion…</div>;
  if (error || !data)
    return (
      <div className="text-(--color-text-muted)">
        Could not prepare a suggestion for this issue.
      </div>
    );

  const pushError = push.error as Error | null;
  const locked = data.status === "pushed";

  return (
    <div className="flex flex-col gap-3" data-testid="suggestion-drawer">
      <div className="text-sm font-semibold">
        Proposed changes · {data.status}
        {data.edited ? " (edited)" : ""}
      </div>

      <pre
        className="overflow-x-auto rounded-lg border border-(--color-border) bg-(--color-surface) p-3 text-[12px] leading-relaxed"
        data-testid="suggestion-diff"
      >
        {data.diff.map((d, i) => (
          <div key={i} className={diffLineClass(d.op)}>
            {diffPrefix(d.op)}
            {d.line}
          </div>
        ))}
      </pre>

      {!locked ? (
        <textarea
          aria-label="Edit proposed body"
          className="min-h-40 rounded-lg border border-(--color-border) bg-(--color-surface) p-3 font-mono text-[12px]"
          value={body}
          onChange={(e) => setDraft(e.target.value)}
        />
      ) : null}

      {pushError ? (
        <div className="text-(--type-bug)" data-testid="push-error">
          {pushError.message}
        </div>
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          className={btn}
          disabled={locked || draft === null || save.isPending}
          onClick={() => save.mutate(body)}
        >
          Save edits
        </button>
        <button
          type="button"
          className={btn}
          disabled={locked || setStatus.isPending}
          onClick={() => setStatus.mutate("suggested")}
        >
          Save as suggestion
        </button>
        <button
          type="button"
          className={`${btn} text-(--color-primary)`}
          disabled={locked || push.isPending}
          onClick={() => push.mutate()}
          data-testid="approve-push"
        >
          Approve &amp; push
        </button>
        <button
          type="button"
          className={btn}
          disabled={locked || setStatus.isPending}
          onClick={() => setStatus.mutate("rejected")}
        >
          Reject
        </button>
        <button
          type="button"
          className={btn}
          disabled={regenerate.isPending}
          onClick={() => regenerate.mutate()}
        >
          Regenerate
        </button>
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Lint the frontend**

Run: `cd frontend && npm run lint`
Expected: PASS (Tasks 8 + 9 together now type-check; no `bg-[--...]` bracket syntax).

- [ ] **Step 4: Commit**

```bash
git add frontend/src/lib/api.ts frontend/src/app/triage/suggestion-drawer.tsx
git commit -m "feat: suggestion drawer with diff, edit, and approve/push/reject actions"
```

---

### Task 10: Playwright e2e for the triage flow

**Files:**
- Create: `frontend/e2e/triage.spec.ts`

**Interfaces:**
- Consumes: the running dev frontend + stubbed `/api/backend/*` routes (no real backend).

- [ ] **Step 1: Write the e2e spec**

Create `frontend/e2e/triage.spec.ts`:

```ts
import { expect, test, type Page, type Route } from "@playwright/test";

const inbox = {
  items: [
    {
      id: 1,
      number: 182,
      title: "Auth fails after refresh",
      repo_full_name: "patelmj/mehova",
      issue_type: "bug",
      component: "auth",
      readiness_score: 42,
      missing: [
        { id: "repro_steps", label: "Reproduction steps" },
        { id: "environment", label: "Environment or version" },
      ],
      suggestion_status: null,
    },
  ],
  total: 1,
  limit: 50,
  offset: 0,
};

const repos = [{ id: 500, full_name: "patelmj/mehova" }];

const suggestion = {
  issue_id: 1,
  status: "draft",
  base_body: "Auth fails.",
  proposed_body: "Auth fails.\n\n## Reproduction Steps\n1. \n",
  missing_requirements: [{ id: "repro_steps", label: "Reproduction steps" }],
  edited: false,
  diff: [
    { op: "context", line: "Auth fails." },
    { op: "add", line: "## Reproduction Steps" },
  ],
  pushed_at: null,
};

async function stub(page: Page) {
  await page.route(/\/api\/backend\/repositories$/, (r: Route) => r.fulfill({ json: repos }));
  await page.route(/\/api\/backend\/triage\/inbox/, (r: Route) => r.fulfill({ json: inbox }));
  await page.route(/\/api\/backend\/issues\/1\/suggestion\/push$/, (r: Route) =>
    r.fulfill({ json: { ...suggestion, status: "pushed" } }),
  );
  await page.route(/\/api\/backend\/issues\/1\/suggestion$/, (r: Route) => {
    if (r.request().method() === "PATCH") {
      const parsed = JSON.parse(r.request().postData() ?? "{}");
      return r.fulfill({ json: { ...suggestion, ...parsed, edited: !!parsed.proposed_body } });
    }
    return r.fulfill({ json: suggestion }); // POST generate
  });
}

test("inbox shows the needs-detail row with missing chips", async ({ page }) => {
  await stub(page);
  await page.goto("/triage");
  await expect(page.getByTestId("triage-row")).toBeVisible();
  await expect(page.getByTestId("missing-chips")).toContainText("Reproduction steps");
  await expect(page.getByTestId("missing-chips")).toContainText("Environment");
});

test("suggest fixes opens the diff drawer", async ({ page }) => {
  await stub(page);
  await page.goto("/triage");
  const suggest = page.getByRole("button", { name: "Suggest fixes" });
  await expect(async () => {
    await suggest.click();
    await expect(page.getByTestId("suggestion-drawer")).toBeVisible();
  }).toPass();
  await expect(page.getByTestId("suggestion-diff")).toContainText("## Reproduction Steps");
});

test("approve & push marks the suggestion pushed", async ({ page }) => {
  await stub(page);
  await page.goto("/triage");
  await expect(async () => {
    await page.getByRole("button", { name: "Suggest fixes" }).click();
    await expect(page.getByTestId("suggestion-drawer")).toBeVisible();
  }).toPass();
  await page.getByTestId("approve-push").click();
  await expect(page.getByTestId("suggestion-drawer")).toContainText("pushed");
});
```

- [ ] **Step 2: Restart the frontend container and run the e2e**

The Docker frontend serves stale builds; restart before e2e (project gotcha).

Run:
```bash
docker restart issuelens-frontend-1
cd frontend && npx playwright test e2e/triage.spec.ts
```
Expected: PASS (3 tests). If a click races hydration, the `expect(...).toPass()` wrappers retry.

- [ ] **Step 3: Commit**

```bash
git add frontend/e2e/triage.spec.ts
git commit -m "test: e2e for triage inbox, suggestion diff, and approve/push"
```

---

### Task 11: Document the `issues: write` prerequisite

**Files:**
- Modify: `README.md` (GitHub App setup section)

**Interfaces:** none (docs only).

- [ ] **Step 1: Add the prerequisite note**

In `README.md`, under the GitHub App setup section, add:

```markdown
### Triage push requires write permission

The triage inbox can push scaffolded section changes back to an issue's body. This
needs the GitHub App to hold **Issues: Read & write** (the sync path only needs Read).
After changing the permission in the App settings, **re-accept the installation** on
each repository (GitHub emails the owner a permission-update prompt). Until this is
done, generating suggestions, editing, and saving still work; only **Approve & push**
fails, with a clear "ensure the App has Issues: write permission" message.
```

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -m "docs: note Issues:write prerequisite for triage push"
```

---

## Final Verification (run before requesting review)

- [ ] Backend: `cd backend && python -m pytest -q && ruff check app tests` → all green.
- [ ] Frontend: `cd frontend && npm run lint` → clean.
- [ ] E2e: `docker restart issuelens-frontend-1 && cd frontend && npx playwright test e2e/triage.spec.ts` → 3 pass.
- [ ] Live smoke (real backend + Ollama, a synced repo with a low-readiness issue): open `/triage`, confirm a row with chips, click **Suggest fixes**, confirm the diff shows appended scaffold sections, edit + Save, Save as suggestion (reload → status persists). Approve & push is only fully testable once the App has `issues: write`; otherwise confirm the 502 message renders in the drawer.

---

## Spec Coverage Self-Check

- §5 inbox / §5.1 categories → Tasks 5, 8 (Needs-Detail queue + derived chips; full taxonomy explicitly deferred).
- §6.4 diff / Approve / Edit / Reject / Save-as-suggestion → Tasks 3, 6, 7, 9. ("Ask author" deferred → issue #29.)
- §21.1 items 7 (inbox), 8 (suggest sections), 9 (preview diff), 10 (approve+push) → Tasks 5/8, 2, 3/9, 7.
- §22 step 4 (triage) / step 6 (approve changes sync back) → Tasks 8, 7.
- Write-safety + re-score → Task 7. Deterministic scaffolds → Task 2. Persistence → Task 1.
