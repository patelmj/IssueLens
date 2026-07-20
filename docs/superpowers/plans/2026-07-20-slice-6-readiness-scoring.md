# Issue Readiness Scoring Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every classified non-PR issue gets an explainable readiness score (0–100) against a type-specific rubric, surfaced as a sortable `Ready` column, a `Readiness <` threshold filter, and a row-expand +/- factor drawer.

**Architecture:** A local LLM (existing Ollama stack) judges each rubric requirement present/absent; the score is a deterministic weighted sum. Results live in a new `issue_readiness` table, produced by a stale-driven arq job chained after classify (`sync → classify → readiness`) plus a cron safety-net sweep. The API outer-joins readiness into the issues list and serves a lazy breakdown endpoint the drawer fetches on expand.

**Tech Stack:** Python 3.12 · FastAPI · SQLAlchemy 2.0 (async) · Alembic · arq/Redis · httpx · Ollama structured output · Next.js (frontend/AGENTS.md variant) · React Query · Tailwind v4 · pytest/respx · Playwright.

## Global Constraints

- **No new Python dependencies** — Ollama is called over `httpx` REST only.
- **Ollama call shape** (match `classify`): POST `/api/chat` with `stream: false`, `think: false`, `format: <schema>`, `options: {"temperature": 0}`, model = `get_settings().ollama_model`.
- **`worker.py` keeps `keep_result = 0`** — a retained result key blocks re-enqueueing the same `_job_id` for an hour (slice-4/5 gotcha).
- **Every arq re-enqueue uses a stable dedupe key**: `readiness-{repo_id}`.
- **Per-issue LLM failures are skipped, never fatal** — log and `continue`; the issue stays stale for the next run. Only infrastructure failure (e.g. Ollama unreachable) marks the `SyncJob` `error` and re-raises.
- **All rubrics MUST sum to exactly 100** — enforced by a module-load assertion.
- **Tailwind v4 CSS custom properties use parentheses** — `text-(--color-x)`, never `text-[--color-x]` (empty-rule bug).
- **Inactive UI elements stay visible but muted** — never hidden (house rule).
- **Frontend:** this Next.js has breaking changes; read the relevant guide in `frontend/node_modules/next/dist/docs/` before writing component code. Follow the patterns already in `plan-client.tsx` / `toolbar.tsx`.
- **Commit messages:** no AI attribution / `Co-Authored-By` / model tags. Use `feat:` / `test:` / `docs:` prefixes.
- **Scope boundary:** the §6.4 proposed-change **diff** and Approve/Edit/Reject/Save/Ask-author **push-to-GitHub** actions are OUT (they belong to the triage inbox, #7). The drawer is built to host them later.

## File Structure

**Create:**
- `backend/app/llm/readiness.py` — rubric tables (`Requirement`, `RUBRICS`, 100-sum guard) + scoring job (`build_prompt`, `stale_readiness_query`, `score_repository_issues`).
- `backend/alembic/versions/0005_issue_readiness.py` — `issue_readiness` table migration.
- `backend/tests/test_readiness.py` — unit tests (rubrics, normalization, schema, prompt, stale query).
- `backend/tests/test_readiness_worker.py` — worker chaining + cron tests.
- `frontend/src/app/plan/readiness-drawer.tsx` — breakdown drawer component (lazy-fetches the endpoint).
- `frontend/e2e/readiness.spec.ts` — Playwright coverage.

**Modify:**
- `backend/app/llm/ollama.py` — add `ReadinessError`, `readiness_schema`, `_normalize_readiness`, `score_readiness`.
- `backend/app/models.py` — add `IssueReadiness` model.
- `backend/tests/conftest.py` — add `issue_readiness` to the `clean_db` TRUNCATE list.
- `backend/worker.py` — add `score_readiness_repository` task, chain it from `classify_repository`, add `score_all_repositories` cron.
- `backend/app/routers/issues.py` — `readiness_score` in `IssueOut`, `max_readiness` filter, `readiness` sort, `GET /issues/{id}/readiness` breakdown endpoint.
- `backend/tests/test_api_issues.py` — extend for readiness field/filter/sort/endpoint.
- `frontend/src/app/plan/plan-client.tsx` — `ready` column, `readiness` sort, expand state, drawer row, `max_readiness` plumbing.
- `frontend/src/app/plan/toolbar.tsx` — `Readiness <` threshold select.

---

### Task 1: Rubric tables + readiness LLM primitives

**Files:**
- Create: `backend/app/llm/readiness.py` (rubrics only in this task)
- Modify: `backend/app/llm/ollama.py`
- Test: `backend/tests/test_readiness.py`

**Interfaces:**
- Produces: `Requirement(id: str, label: str, points: int)` (frozen dataclass); `RUBRICS: dict[str, list[Requirement]]` keyed by `"bug"|"feature"|"debt"|"docs"|"question"`.
- Produces (in `ollama.py`): `ReadinessError(Exception)`; `readiness_schema(requirement_ids: list[str]) -> dict`; `_normalize_readiness(raw: dict, requirement_ids: list[str]) -> dict[str, dict]` returning `{rid: {"present": bool, "evidence": str|None}}`; `async score_readiness(client, prompt, requirement_ids) -> dict[str, dict]`.

- [ ] **Step 1: Write failing tests for rubrics + normalization**

Create `backend/tests/test_readiness.py`:

```python
import json

import httpx
import pytest
import respx

from app.llm.ollama import (
    ReadinessError,
    _normalize_readiness,
    readiness_schema,
    score_readiness,
)
from app.llm.readiness import RUBRICS
from app.llm.ollama import make_ollama_client

BASE = "http://127.0.0.1:11434"


def test_every_rubric_sums_to_100():
    assert set(RUBRICS) == {"bug", "feature", "debt", "docs", "question"}
    for issue_type, reqs in RUBRICS.items():
        assert sum(r.points for r in reqs) == 100, issue_type
        ids = [r.id for r in reqs]
        assert len(ids) == len(set(ids)), f"duplicate id in {issue_type}"


def test_readiness_schema_requires_every_requirement():
    schema = readiness_schema(["a", "b"])
    assert schema["required"] == ["a", "b"]
    assert schema["properties"]["a"]["properties"]["present"]["type"] == "boolean"


def test_normalize_defaults_missing_requirement_to_absent():
    out = _normalize_readiness({"a": {"present": True, "evidence": "yes"}}, ["a", "b"])
    assert out["a"] == {"present": True, "evidence": "yes"}
    assert out["b"] == {"present": False, "evidence": None}


def test_normalize_trims_and_caps_evidence():
    out = _normalize_readiness({"a": {"present": True, "evidence": " " + "x" * 300}}, ["a"])
    assert out["a"]["evidence"] == "x" * 200


def test_normalize_blank_evidence_becomes_null():
    out = _normalize_readiness({"a": {"present": False, "evidence": "   "}}, ["a"])
    assert out["a"]["evidence"] is None


@respx.mock(base_url=BASE)
async def test_score_readiness_parses_model_output(respx_mock):
    respx_mock.post("/api/chat").respond(
        json={"message": {"content": json.dumps({"a": {"present": True, "evidence": "ok"}})}}
    )
    async with make_ollama_client() as client:
        out = await score_readiness(client, "prompt", ["a"])
    assert out["a"]["present"] is True


@respx.mock(base_url=BASE)
async def test_score_readiness_raises_on_non_json(respx_mock):
    respx_mock.post("/api/chat").respond(json={"message": {"content": "not json"}})
    async with make_ollama_client() as client:
        with pytest.raises(ReadinessError):
            await score_readiness(client, "prompt", ["a"])
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend && uv run pytest tests/test_readiness.py -v`
Expected: FAIL — `ImportError` (`app.llm.readiness` / new `ollama` names don't exist).

- [ ] **Step 3: Create the rubric tables**

Create `backend/app/llm/readiness.py`:

```python
from dataclasses import dataclass


@dataclass(frozen=True)
class Requirement:
    id: str
    label: str
    points: int


RUBRICS: dict[str, list[Requirement]] = {
    "bug": [
        Requirement("problem_statement", "Problem statement", 15),
        Requirement("expected_behavior", "Expected behavior", 15),
        Requirement("actual_behavior", "Actual behavior", 15),
        Requirement("repro_steps", "Reproduction steps", 20),
        Requirement("environment", "Environment or version", 10),
        Requirement("logs", "Logs, screenshots, or error output", 10),
        Requirement("severity", "Severity or impact", 10),
        Requirement("ownership", "Ownership or category", 5),
    ],
    "feature": [
        Requirement("user_problem", "User or business problem", 20),
        Requirement("desired_outcome", "Desired outcome", 15),
        Requirement("acceptance_criteria", "Acceptance criteria", 20),
        Requirement("scope_boundaries", "Scope boundaries", 15),
        Requirement("technical_constraints", "Technical constraints", 10),
        Requirement("dependencies", "Dependencies", 10),
        Requirement("ownership", "Ownership or category", 5),
        Requirement("estimate", "Estimate", 5),
    ],
    "debt": [
        Requirement("current_implementation", "Current implementation", 15),
        Requirement("why_problem", "Why it is a problem", 20),
        Requirement("affected_systems", "Affected systems", 15),
        Requirement("proposed_direction", "Proposed direction", 15),
        Requirement("risk", "Risk of changing it", 10),
        Requirement("definition_of_done", "Definition of done", 15),
        Requirement("dependencies", "Dependencies", 10),
    ],
    "docs": [
        Requirement("what_wrong", "What is wrong or missing", 30),
        Requirement("where", "Where it lives (page, section, file, or URL)", 25),
        Requirement("audience", "Who it affects or why it matters", 20),
        Requirement("proposed_correction", "Proposed correction or direction", 25),
    ],
    "question": [
        Requirement("context", "Context or goal (what they are trying to do)", 30),
        Requirement("question_stated", "Specific question clearly stated", 30),
        Requirement("already_tried", "What they have already tried", 25),
        Requirement("environment", "Environment or version, if relevant", 15),
    ],
}

for _issue_type, _reqs in RUBRICS.items():
    assert sum(r.points for r in _reqs) == 100, f"rubric {_issue_type} does not sum to 100"
```

- [ ] **Step 4: Add the LLM primitives to `ollama.py`**

Append to `backend/app/llm/ollama.py` (after the existing `classify` function; keep existing imports — `json`, `httpx`, `Any`, `get_settings` are already imported):

```python
MAX_EVIDENCE_LENGTH = 200


class ReadinessError(Exception):
    """The model returned output we could not use for readiness scoring."""


def readiness_schema(requirement_ids: list[str]) -> dict[str, Any]:
    return {
        "type": "object",
        "properties": {
            rid: {
                "type": "object",
                "properties": {
                    "present": {"type": "boolean"},
                    "evidence": {"type": ["string", "null"]},
                },
                "required": ["present"],
            }
            for rid in requirement_ids
        },
        "required": list(requirement_ids),
    }


def _normalize_readiness(
    raw: dict[str, Any], requirement_ids: list[str]
) -> dict[str, dict[str, Any]]:
    if not isinstance(raw, dict):
        raise ReadinessError(f"expected object, got {type(raw).__name__}")
    result: dict[str, dict[str, Any]] = {}
    for rid in requirement_ids:
        item = raw.get(rid)
        if not isinstance(item, dict):
            result[rid] = {"present": False, "evidence": None}
            continue
        evidence = item.get("evidence")
        if isinstance(evidence, str):
            evidence = evidence.strip()[:MAX_EVIDENCE_LENGTH] or None
        else:
            evidence = None
        result[rid] = {"present": bool(item.get("present", False)), "evidence": evidence}
    return result


async def score_readiness(
    client: httpx.AsyncClient, prompt: str, requirement_ids: list[str]
) -> dict[str, dict[str, Any]]:
    resp = await client.post(
        "/api/chat",
        json={
            "model": get_settings().ollama_model,
            "messages": [{"role": "user", "content": prompt}],
            "stream": False,
            "think": False,
            "format": readiness_schema(requirement_ids),
            "options": {"temperature": 0},
        },
    )
    resp.raise_for_status()
    content = resp.json()["message"]["content"]
    try:
        raw = json.loads(content)
    except json.JSONDecodeError as exc:
        raise ReadinessError(f"model returned non-JSON: {content[:200]!r}") from exc
    return _normalize_readiness(raw, requirement_ids)
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd backend && uv run pytest tests/test_readiness.py -v`
Expected: PASS (6 tests). Then `uv run ruff check app tests`.

- [ ] **Step 6: Commit**

```bash
git add backend/app/llm/readiness.py backend/app/llm/ollama.py backend/tests/test_readiness.py
git commit -m "feat: readiness rubrics and Ollama scoring primitives (#6)"
```

---

### Task 2: `issue_readiness` model + migration

**Files:**
- Modify: `backend/app/models.py`
- Create: `backend/alembic/versions/0005_issue_readiness.py`
- Modify: `backend/tests/conftest.py:65-73` (the `clean_db` TRUNCATE)

**Interfaces:**
- Produces: `IssueReadiness` ORM model with columns `issue_id` (BigInt PK FK→issues CASCADE), `issue_type` (Text), `score` (Integer), `factors` (JSONB), `model` (Text), `scored_at` (timestamptz, server_default now()), `issue_gh_updated_at` (timestamptz), `classification_scored_at` (timestamptz).

- [ ] **Step 1: Add the model**

In `backend/app/models.py`, after the `IssueClassification` class (before `SyncJob`), add:

```python
class IssueReadiness(Base):
    __tablename__ = "issue_readiness"

    issue_id: Mapped[int] = mapped_column(
        BigInteger, ForeignKey("issues.id", ondelete="CASCADE"), primary_key=True
    )
    issue_type: Mapped[str] = mapped_column(Text)
    score: Mapped[int] = mapped_column(Integer)
    factors: Mapped[list] = mapped_column(JSONB, default=list)
    model: Mapped[str] = mapped_column(Text)
    scored_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
    issue_gh_updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    classification_scored_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
```

(`BigInteger`, `Integer`, `Text`, `DateTime`, `ForeignKey`, `func`, `JSONB`, `Mapped`, `mapped_column`, `datetime` are all already imported in this file.)

- [ ] **Step 2: Create the migration**

Create `backend/alembic/versions/0005_issue_readiness.py`:

```python
"""issue readiness"""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import JSONB

revision = "0005"
down_revision = "0004"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "issue_readiness",
        sa.Column(
            "issue_id",
            sa.BigInteger(),
            sa.ForeignKey("issues.id", ondelete="CASCADE"),
            primary_key=True,
        ),
        sa.Column("issue_type", sa.Text(), nullable=False),
        sa.Column("score", sa.Integer(), nullable=False),
        sa.Column("factors", JSONB(), nullable=False),
        sa.Column("model", sa.Text(), nullable=False),
        sa.Column(
            "scored_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column("issue_gh_updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("classification_scored_at", sa.DateTime(timezone=True), nullable=False),
    )


def downgrade() -> None:
    op.drop_table("issue_readiness")
```

- [ ] **Step 3: Add `issue_readiness` to the test truncate**

In `backend/tests/conftest.py`, update the `clean_db` TRUNCATE string so the table is reset between tests:

```python
            text(
                "TRUNCATE installations, repositories, issues, issue_classifications, "
                "issue_readiness, sync_jobs RESTART IDENTITY CASCADE"
            )
```

- [ ] **Step 4: Apply the migration and verify the schema**

Run:
```bash
cd backend && uv run alembic upgrade head
uv run python -c "import asyncio,asyncpg; asyncio.run((lambda: None)())"  # noop; next line is the real check
uv run alembic current
```
Expected: `alembic current` prints `0005 (head)`. (The test-DB session fixture will also migrate `issuelens_test` to `0005` on the next pytest run.)

- [ ] **Step 5: Run the existing suite to confirm nothing broke**

Run: `cd backend && uv run pytest -q`
Expected: PASS (existing tests green; the new `test_readiness.py` unit tests still pass).

- [ ] **Step 6: Commit**

```bash
git add backend/app/models.py backend/alembic/versions/0005_issue_readiness.py backend/tests/conftest.py
git commit -m "feat: issue_readiness table and model (#6)"
```

---

### Task 3: Scoring job — prompt, stale query, `score_repository_issues`

**Files:**
- Modify: `backend/app/llm/readiness.py`
- Test: `backend/tests/test_readiness.py` (extend)

**Interfaces:**
- Consumes: `RUBRICS`, `Requirement` (Task 1); `score_readiness`, `ensure_model`, `ReadinessError` (Task 1 / existing `ollama.py`); `IssueReadiness`, `IssueClassification`, `Issue`, `Repository`, `SyncJob` (Task 2 / existing models).
- Produces: `build_prompt(repo_full_name: str, issue: Issue, issue_type: str, rubric: list[Requirement]) -> str`; `stale_readiness_query(repo_id: int) -> Select` returning `(Issue, IssueClassification)` rows; `async score_repository_issues(session, client, repo_id) -> int`.

- [ ] **Step 1: Write the failing job tests**

Append to `backend/tests/test_readiness.py`:

```python
from datetime import datetime, timedelta, timezone

from sqlalchemy import select

from app.db import get_sessionmaker
from app.llm.readiness import (
    build_prompt,
    score_repository_issues,
    stale_readiness_query,
)
from app.models import (
    Installation,
    Issue,
    IssueClassification,
    IssueReadiness,
    Repository,
    SyncJob,
)

NOW = datetime.now(timezone.utc)
TAGS_OK = {"models": [{"name": "test-model"}]}


def readiness_chat(present_ids: set[str], all_ids: list[str]) -> httpx.Response:
    payload = {
        rid: {"present": rid in present_ids, "evidence": "e" if rid in present_ids else None}
        for rid in all_ids
    }
    return httpx.Response(
        200, json={"message": {"role": "assistant", "content": json.dumps(payload)}}
    )


async def seed_classified_issue(issue_type="bug", classified_delta=timedelta(hours=1)):
    async with get_sessionmaker()() as session:
        session.add(Installation(id=42, account_login="patelmj"))
        session.add(
            Repository(id=500, installation_id=42, full_name="patelmj/mehova",
                       owner="patelmj", name="mehova")
        )
        await session.flush()
        session.add(
            Issue(id=1, repository_id=500, number=1, title="Login crashes", state="open",
                  body="It crashes on login", gh_created_at=NOW - timedelta(days=5),
                  gh_updated_at=NOW - timedelta(days=1))
        )
        session.add(
            Issue(id=2, repository_id=500, number=2, title="Unclassified", state="open",
                  gh_created_at=NOW, gh_updated_at=NOW)
        )
        await session.flush()
        session.add(
            IssueClassification(
                issue_id=1, issue_type=issue_type, component="auth", confidence=0.9,
                model="test-model", classified_at=NOW - classified_delta,
                issue_gh_updated_at=NOW - timedelta(days=1),
            )
        )
        await session.commit()


async def run_job() -> int:
    async with get_sessionmaker()() as session, make_ollama_client() as client:
        return await score_repository_issues(session, client, 500)


@respx.mock(base_url=BASE)
async def test_scores_classified_issue_with_deterministic_sum(clean_db, respx_mock):
    await seed_classified_issue("bug")
    respx_mock.get("/api/tags").respond(json=TAGS_OK)
    bug_ids = [r.id for r in RUBRICS["bug"]]
    respx_mock.post("/api/chat").mock(
        return_value=readiness_chat({"problem_statement", "repro_steps"}, bug_ids)
    )

    assert await run_job() == 1

    async with get_sessionmaker()() as session:
        row = (await session.execute(select(IssueReadiness))).scalar_one()
    assert row.issue_id == 1
    assert row.issue_type == "bug"
    assert row.score == 15 + 20  # problem_statement + repro_steps
    assert row.model == "test-model"
    present = {f["requirement"] for f in row.factors if f["present"]}
    assert present == {"Problem statement", "Reproduction steps"}
    assert len(row.factors) == len(bug_ids)

    jobs = (await session_jobs())
    assert jobs[0].status == "success" and jobs[0].issues_upserted == 1


async def session_jobs() -> list[SyncJob]:
    async with get_sessionmaker()() as session:
        return list(
            (await session.execute(
                select(SyncJob).where(SyncJob.kind == "readiness").order_by(SyncJob.id)
            )).scalars()
        )


@respx.mock(base_url=BASE)
async def test_unclassified_issue_is_skipped(clean_db, respx_mock):
    await seed_classified_issue("bug")
    respx_mock.get("/api/tags").respond(json=TAGS_OK)
    bug_ids = [r.id for r in RUBRICS["bug"]]
    respx_mock.post("/api/chat").mock(return_value=readiness_chat(set(), bug_ids))
    await run_job()
    async with get_sessionmaker()() as session:
        ids = list((await session.execute(select(IssueReadiness.issue_id))).scalars())
    assert ids == [1]  # issue 2 has no classification -> never scored


@respx.mock(base_url=BASE)
async def test_rescore_on_reclassification(clean_db, respx_mock):
    await seed_classified_issue("bug")
    respx_mock.get("/api/tags").respond(json=TAGS_OK)
    bug_ids = [r.id for r in RUBRICS["bug"]]
    respx_mock.post("/api/chat").mock(return_value=readiness_chat({"problem_statement"}, bug_ids))
    assert await run_job() == 1
    # Nothing stale now
    assert await run_job() == 0
    # Re-classify (newer classified_at) -> stale again
    async with get_sessionmaker()() as session:
        cls = (await session.execute(
            select(IssueClassification).where(IssueClassification.issue_id == 1)
        )).scalar_one()
        cls.classified_at = NOW
        await session.commit()
    assert await run_job() == 1


@respx.mock(base_url=BASE)
async def test_ollama_down_marks_job_error(clean_db, respx_mock):
    await seed_classified_issue("bug")
    respx_mock.get("/api/tags").mock(side_effect=httpx.ConnectError("refused"))
    with pytest.raises(httpx.ConnectError):
        await run_job()
    jobs = await session_jobs()
    assert jobs[0].status == "error" and jobs[0].error is not None


async def test_stale_query_and_prompt(clean_db):
    await seed_classified_issue("feature")
    async with get_sessionmaker()() as session:
        rows = (await session.execute(stale_readiness_query(500))).all()
    assert [issue.id for issue, _cls in rows] == [1]
    issue, cls = rows[0]
    prompt = build_prompt("patelmj/mehova", issue, cls.issue_type, RUBRICS["feature"])
    assert "patelmj/mehova" in prompt
    assert "Acceptance criteria" in prompt
    assert "feature" in prompt
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd backend && uv run pytest tests/test_readiness.py -k "job or stale or scores or unclassified or rescore or ollama_down" -v`
Expected: FAIL — `ImportError` (`build_prompt` / `score_repository_issues` / `stale_readiness_query` not defined).

- [ ] **Step 3: Implement the job in `readiness.py`**

Append to `backend/app/llm/readiness.py` (add imports at the top of the file):

```python
import logging

import httpx
from sqlalchemy import Select, func, select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import get_settings
from app.llm.ollama import ReadinessError, ensure_model, score_readiness
from app.models import Issue, IssueClassification, IssueReadiness, Repository, SyncJob

logger = logging.getLogger(__name__)

MAX_BODY_CHARS = 4000

PROMPT_TEMPLATE = """You are assessing how ready a GitHub {issue_type} issue is to be \
worked on.

An issue is "ready" when it contains the information a developer needs to act without \
asking follow-up questions. Judge ONLY what the issue text below actually contains; do \
not assume missing information is present.

Repository: {repo_full_name}
Issue title: {title}
Issue body:
{body}

For each of the following requirements, decide whether the issue satisfies it:
{requirements}

For each requirement return an object with:
- "present": true only if the issue clearly satisfies the requirement, false otherwise.
- "evidence": a short quote or paraphrase (max ~20 words) supporting "present": true, \
or null when absent.
"""


def build_prompt(
    repo_full_name: str, issue: Issue, issue_type: str, rubric: list[Requirement]
) -> str:
    requirements = "\n".join(f'- "{r.id}": {r.label}' for r in rubric)
    return PROMPT_TEMPLATE.format(
        issue_type=issue_type,
        repo_full_name=repo_full_name,
        title=issue.title,
        body=(issue.body or "")[:MAX_BODY_CHARS] or "(empty)",
        requirements=requirements,
    )


def stale_readiness_query(repo_id: int) -> Select:
    """Classified issues with no readiness, a changed body, or a newer classification."""
    return (
        select(Issue, IssueClassification)
        .join(IssueClassification, IssueClassification.issue_id == Issue.id)
        .outerjoin(IssueReadiness, IssueReadiness.issue_id == Issue.id)
        .where(
            Issue.repository_id == repo_id,
            Issue.is_pull_request.is_(False),
            IssueReadiness.issue_id.is_(None)
            | (Issue.gh_updated_at > IssueReadiness.issue_gh_updated_at)
            | (
                IssueClassification.classified_at
                > IssueReadiness.classification_scored_at
            ),
        )
        .order_by(Issue.id)
    )


async def score_repository_issues(
    session: AsyncSession, client: httpx.AsyncClient, repo_id: int
) -> int:
    repo = (
        await session.execute(select(Repository).where(Repository.id == repo_id))
    ).scalar_one()
    job = SyncJob(repository_id=repo_id, kind="readiness", status="running")
    session.add(job)
    await session.commit()
    job_id = job.id
    try:
        await ensure_model(client)
        rows = list((await session.execute(stale_readiness_query(repo_id))).all())
        scored = 0
        for issue, classification in rows:
            rubric = RUBRICS[classification.issue_type]
            requirement_ids = [r.id for r in rubric]
            prompt = build_prompt(
                repo.full_name, issue, classification.issue_type, rubric
            )
            try:
                result = await score_readiness(client, prompt, requirement_ids)
            except (httpx.HTTPError, ReadinessError):
                logger.exception(
                    "readiness scoring failed for issue %s in repo %s", issue.id, repo_id
                )
                continue
            score = sum(r.points for r in rubric if result[r.id]["present"])
            factors = [
                {
                    "requirement": r.label,
                    "points": r.points,
                    "present": result[r.id]["present"],
                    "evidence": result[r.id]["evidence"],
                }
                for r in rubric
            ]
            values = {
                "issue_id": issue.id,
                "issue_type": classification.issue_type,
                "score": score,
                "factors": factors,
                "model": get_settings().ollama_model,
                "scored_at": func.now(),
                "issue_gh_updated_at": issue.gh_updated_at,
                "classification_scored_at": classification.classified_at,
            }
            await session.execute(
                pg_insert(IssueReadiness)
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

- [ ] **Step 4: Run the readiness suite to verify it passes**

Run: `cd backend && uv run pytest tests/test_readiness.py -v`
Expected: PASS (all unit + job tests). Then `uv run ruff check app tests`.

- [ ] **Step 5: Commit**

```bash
git add backend/app/llm/readiness.py backend/tests/test_readiness.py
git commit -m "feat: readiness scoring job with staleness query (#6)"
```

---

### Task 4: Worker wiring — chain + cron sweep

**Files:**
- Modify: `backend/worker.py`
- Test: `backend/tests/test_readiness_worker.py`

**Interfaces:**
- Consumes: `score_repository_issues` (Task 3); existing `classify_repository`, `make_ollama_client`, `get_sessionmaker`.
- Produces: `async score_readiness_repository(ctx, repo_id) -> int`; `async score_all_repositories(ctx) -> int`; `classify_repository` now enqueues `score_readiness_repository` with `_job_id=f"readiness-{repo_id}"`.

- [ ] **Step 1: Write the failing worker tests**

Create `backend/tests/test_readiness_worker.py`:

```python
import worker


class FakeRedis:
    def __init__(self):
        self.calls = []

    async def enqueue_job(self, *args, **kwargs):
        self.calls.append((args, kwargs))
        return object()


async def test_classify_repository_enqueues_readiness(monkeypatch):
    async def fake_classify(session, client, repo_id):
        return 7

    monkeypatch.setattr(worker, "classify_repository_issues", fake_classify)
    redis = FakeRedis()

    result = await worker.classify_repository({"redis": redis}, 500)

    assert result == 7
    assert redis.calls == [
        (("score_readiness_repository", 500), {"_job_id": "readiness-500"})
    ]


async def test_classify_failure_does_not_enqueue_readiness(monkeypatch):
    async def failing(session, client, repo_id):
        raise RuntimeError("ollama down")

    monkeypatch.setattr(worker, "classify_repository_issues", failing)
    redis = FakeRedis()
    try:
        await worker.classify_repository({"redis": redis}, 500)
    except RuntimeError:
        pass
    else:
        raise AssertionError("expected RuntimeError")
    assert redis.calls == []


def test_worker_registers_readiness_jobs():
    names = {getattr(fn, "name", None) or fn.__name__ for fn in worker.WorkerSettings.functions}
    assert "score_readiness_repository" in names
    cron_names = {job.name for job in worker.WorkerSettings.cron_jobs}
    assert "score_all_repositories" in cron_names


async def test_readiness_sweep_enqueues_with_dedupe_key(clean_db):
    from app.db import get_sessionmaker
    from app.models import Installation, Repository

    async with get_sessionmaker()() as session:
        session.add(Installation(id=42, account_login="patelmj"))
        await session.flush()
        session.add(
            Repository(id=500, installation_id=42, full_name="patelmj/mehova",
                       owner="patelmj", name="mehova")
        )
        await session.commit()

    redis = FakeRedis()
    result = await worker.score_all_repositories({"redis": redis})
    assert result == 1
    assert redis.calls == [
        (("score_readiness_repository", 500), {"_job_id": "readiness-500"})
    ]
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd backend && uv run pytest tests/test_readiness_worker.py -v`
Expected: FAIL — `AttributeError` (`worker.score_readiness_repository` / `score_all_repositories` don't exist) and the classify test asserts an enqueue that isn't happening yet.

- [ ] **Step 3: Wire the worker**

In `backend/worker.py`:

1. Add the import near the top (with the other `app.llm` imports):
```python
from app.llm.readiness import score_repository_issues
```

2. Extend `classify_repository` to chain readiness (replace the existing function body):
```python
async def classify_repository(ctx: dict, repo_id: int) -> int:
    async with get_sessionmaker()() as session, make_ollama_client() as client:
        count = await classify_repository_issues(session, client, repo_id)
    redis = ctx.get("redis")
    if redis is not None:
        await redis.enqueue_job(
            "score_readiness_repository", repo_id, _job_id=f"readiness-{repo_id}"
        )
    return count
```

3. Add the new task + sweep (after `classify_all_repositories`):
```python
async def score_readiness_repository(ctx: dict, repo_id: int) -> int:
    async with get_sessionmaker()() as session, make_ollama_client() as client:
        return await score_repository_issues(session, client, repo_id)


async def score_all_repositories(ctx: dict) -> int:
    """Safety net for issues classified while Ollama was down; enqueues via the dedupe key."""
    from sqlalchemy import select

    from app.models import Repository

    async with get_sessionmaker()() as session:
        repo_ids = list((await session.execute(select(Repository.id))).scalars())
    done = 0
    for repo_id in repo_ids:
        try:
            await ctx["redis"].enqueue_job(
                "score_readiness_repository", repo_id, _job_id=f"readiness-{repo_id}"
            )
            done += 1
        except Exception:
            logger.exception("readiness sweep failed for repo %s", repo_id)
    return done
```

4. Register both in `WorkerSettings` (update `functions` and `cron_jobs`):
```python
    functions = [
        func(ping, keep_result=60),
        sync_repository,
        classify_repository,
        score_readiness_repository,
    ]
    cron_jobs = [
        cron(reconcile_all_repositories, name="reconcile_all_repositories", minute={0, 30}),
        cron(classify_all_repositories, name="classify_all_repositories", minute={15, 45}),
        cron(score_all_repositories, name="score_all_repositories", minute={20, 50}),
    ]
```

- [ ] **Step 4: Run the worker tests to verify they pass**

Run: `cd backend && uv run pytest tests/test_readiness_worker.py tests/test_classify_worker.py -v`
Expected: PASS (new readiness worker tests + existing classify worker tests still green). Then `uv run ruff check app tests worker.py`.

- [ ] **Step 5: Commit**

```bash
git add backend/worker.py backend/tests/test_readiness_worker.py
git commit -m "feat: chain readiness after classify and add cron sweep (#6)"
```

---

### Task 5: API — readiness field, filter, sort, breakdown endpoint

**Files:**
- Modify: `backend/app/routers/issues.py`
- Test: `backend/tests/test_api_issues.py` (extend)

**Interfaces:**
- Consumes: `IssueReadiness` model (Task 2).
- Produces: `IssueOut.readiness_score: int | None`; `?max_readiness=<int>` filter (`score < max_readiness`); `?sort=readiness`; `GET /issues/{issue_id}/readiness -> ReadinessOut{score, issue_type, scored_at, factors: list[FactorOut{requirement, points, present, evidence}]}` (404 when absent).

- [ ] **Step 1: Write the failing API tests**

Append to `backend/tests/test_api_issues.py` (extend the existing `IssueReadiness` import into the models import line first: `from app.models import Installation, Issue, IssueClassification, IssueReadiness, Repository`):

```python
async def seed_readiness():
    async with get_sessionmaker()() as session:
        session.add(
            IssueReadiness(
                issue_id=1, issue_type="bug", score=42,
                factors=[
                    {"requirement": "Problem statement", "points": 15, "present": True, "evidence": "crash"},
                    {"requirement": "Reproduction steps", "points": 20, "present": False, "evidence": None},
                ],
                model="test-model",
                issue_gh_updated_at=NOW - timedelta(days=1),
                classification_scored_at=NOW - timedelta(hours=1),
            )
        )
        session.add(
            IssueReadiness(
                issue_id=4, issue_type="feature", score=88, factors=[],
                model="test-model",
                issue_gh_updated_at=NOW - timedelta(hours=3),
                classification_scored_at=NOW - timedelta(hours=1),
            )
        )
        await session.commit()


async def test_rows_include_readiness_score(clean_db, api):
    await seed_issues()
    await seed_readiness()
    body = await get_body(api, "/issues?sort=number&order=asc")
    by_title = {i["title"]: i for i in body["items"]}
    assert by_title["Alpha bug"]["readiness_score"] == 42
    assert by_title["Delta task"]["readiness_score"] == 88
    assert by_title["Beta feature"]["readiness_score"] is None  # closed, unscored


async def test_max_readiness_filter_excludes_high_and_unscored(clean_db, api):
    await seed_issues()
    await seed_readiness()
    body = await get_body(api, "/issues?max_readiness=80")
    assert [i["title"] for i in body["items"]] == ["Alpha bug"]  # 42<80; 88 and unscored excluded


async def test_sort_by_readiness_puts_nulls_last(clean_db, api):
    await seed_issues()
    await seed_readiness()
    body = await get_body(api, "/issues?state=all&sort=readiness&order=desc")
    scores = [i["readiness_score"] for i in body["items"]]
    assert scores[:2] == [88, 42]
    assert scores[-1] is None


async def test_readiness_breakdown_endpoint(clean_db, api):
    await seed_issues()
    await seed_readiness()
    body = await get_body(api, "/issues/1/readiness")
    assert body["score"] == 42
    assert body["issue_type"] == "bug"
    assert body["factors"][0]["requirement"] == "Problem statement"
    assert body["factors"][0]["present"] is True


async def test_readiness_breakdown_404_when_absent(clean_db, api):
    await seed_issues()
    async with api as client:
        assert (await client.get("/issues/2/readiness")).status_code == 404


async def test_bad_max_readiness_is_422(clean_db, api):
    async with api as client:
        assert (await client.get("/issues?max_readiness=200")).status_code == 422
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd backend && uv run pytest tests/test_api_issues.py -k readiness -v`
Expected: FAIL — `readiness_score` missing from payload / `max_readiness` unknown param ignored / `/issues/1/readiness` returns 404 for the wrong reason (route undefined).

- [ ] **Step 3: Update the router**

In `backend/app/routers/issues.py`:

1. Imports — add `HTTPException` and `IssueReadiness`:
```python
from fastapi import APIRouter, Depends, HTTPException, Query
...
from app.models import Issue, IssueClassification, IssueReadiness, Repository
```

2. `SORT_COLUMNS` — add the readiness column:
```python
SORT_COLUMNS = {
    "updated": Issue.gh_updated_at,
    "created": Issue.gh_created_at,
    "comments": Issue.comments_count,
    "number": Issue.number,
    "title": Issue.title,
    "readiness": IssueReadiness.score,
}
```

3. `IssueOut` — add the field (after `classification_confidence`):
```python
    readiness_score: int | None
```

4. `_filtered_query` — add `max_readiness` param, the join, and the filter. Replace the signature and body:
```python
def _filtered_query(
    repo_id: int | None,
    state: str,
    label: str | None,
    assignee: str | None,
    q: str | None,
    issue_type: str | None,
    component: str | None,
    max_readiness: int | None,
) -> Select:
    query = (
        select(Issue, Repository.full_name, IssueClassification, IssueReadiness)
        .join(Repository, Issue.repository_id == Repository.id)
        .outerjoin(IssueClassification, IssueClassification.issue_id == Issue.id)
        .outerjoin(IssueReadiness, IssueReadiness.issue_id == Issue.id)
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
    if issue_type:
        query = query.where(IssueClassification.issue_type == issue_type)
    if component:
        query = query.where(IssueClassification.component == component)
    if max_readiness is not None:
        query = query.where(IssueReadiness.score < max_readiness)
    if q:
        clause = Issue.title.ilike(f"%{_escape_like(q)}%")
        if q.isdigit():
            clause = clause | (Issue.number == int(q))
        query = query.where(clause)
    return query
```

5. `list_issues` — add the param, extend the `sort` Literal, thread `max_readiness`, apply NULLS LAST, and unpack the 4-tuple:
```python
@router.get("", response_model=IssuePage)
async def list_issues(
    session: AsyncSession = Depends(get_session),
    repo_id: int | None = None,
    state: Literal["open", "closed", "all"] = "open",
    label: str | None = None,
    assignee: str | None = None,
    q: str | None = None,
    issue_type: IssueType | None = Query(None, alias="type"),
    component: str | None = None,
    max_readiness: int | None = Query(None, ge=0, le=100),
    sort: Literal["updated", "created", "comments", "number", "title", "readiness"] = "updated",
    order: Literal["asc", "desc"] = "desc",
    limit: int = Query(50, ge=1, le=100),
    offset: int = Query(0, ge=0),
) -> IssuePage:
    query = _filtered_query(
        repo_id, state, label, assignee, q, issue_type, component, max_readiness
    )
    total = (
        await session.execute(select(func.count()).select_from(query.subquery()))
    ).scalar_one()
    column = SORT_COLUMNS[sort]
    direction = column.asc() if order == "asc" else column.desc()
    ordered = query.order_by(direction.nulls_last(), Issue.id)
    rows = (await session.execute(ordered.limit(limit).offset(offset))).all()
    items = [
        IssueOut(
            repo_full_name=full_name,
            issue_type=classification.issue_type if classification else None,
            component=classification.component if classification else None,
            classification_confidence=(
                classification.confidence if classification else None
            ),
            readiness_score=readiness.score if readiness else None,
            **{field: getattr(issue, field) for field in ISSUE_FIELDS},
        )
        for issue, full_name, classification, readiness in rows
    ]
    return IssuePage(items=items, total=total, limit=limit, offset=offset)
```

6. Breakdown endpoint — add after the `issue_facets` route:
```python
class FactorOut(BaseModel):
    requirement: str
    points: int
    present: bool
    evidence: str | None


class ReadinessOut(BaseModel):
    score: int
    issue_type: str
    scored_at: datetime
    factors: list[FactorOut]


@router.get("/{issue_id}/readiness", response_model=ReadinessOut)
async def issue_readiness(
    issue_id: int, session: AsyncSession = Depends(get_session)
) -> ReadinessOut:
    row = (
        await session.execute(
            select(IssueReadiness).where(IssueReadiness.issue_id == issue_id)
        )
    ).scalar_one_or_none()
    if row is None:
        raise HTTPException(status_code=404, detail="No readiness score for this issue")
    return ReadinessOut(
        score=row.score,
        issue_type=row.issue_type,
        scored_at=row.scored_at,
        factors=[FactorOut(**f) for f in row.factors],
    )
```

- [ ] **Step 4: Run the API tests to verify they pass**

Run: `cd backend && uv run pytest tests/test_api_issues.py -v`
Expected: PASS (new readiness tests + all existing issue tests). Then full backend suite `uv run pytest -q` and `uv run ruff check app tests`.

- [ ] **Step 5: Commit**

```bash
git add backend/app/routers/issues.py backend/tests/test_api_issues.py
git commit -m "feat: readiness score field, filter, sort, and breakdown endpoint (#6)"
```

---

### Task 6: Frontend — Ready column + expand drawer

**Files:**
- Create: `frontend/src/app/plan/readiness-drawer.tsx`
- Modify: `frontend/src/app/plan/plan-client.tsx`

**Interfaces:**
- Consumes: `GET /api/backend/issues/{id}/readiness` (Task 5) → `{score, issue_type, scored_at, factors: [{requirement, points, present, evidence}]}`; list rows now carry `readiness_score: number | null`.
- Produces: a `ready` column and a per-row expandable drawer in the issues table.

> Before writing components, read the relevant guide under `frontend/node_modules/next/dist/docs/` (see `frontend/AGENTS.md`) and mirror the existing `plan-client.tsx` patterns.

- [ ] **Step 1: Create the drawer component**

Create `frontend/src/app/plan/readiness-drawer.tsx`:

```tsx
"use client";

import { useQuery } from "@tanstack/react-query";
import { getJson } from "../../lib/api";

type Factor = {
  requirement: string;
  points: number;
  present: boolean;
  evidence: string | null;
};

type ReadinessBreakdown = {
  score: number;
  issue_type: string;
  scored_at: string;
  factors: Factor[];
};

export function ReadinessDrawer({ issueId }: { issueId: number }) {
  const { data, error, isPending } = useQuery({
    queryKey: ["readiness", issueId],
    queryFn: () =>
      getJson<ReadinessBreakdown>(`/api/backend/issues/${issueId}/readiness`),
  });

  if (isPending) {
    return <div className="text-(--color-text-muted)">Loading readiness…</div>;
  }
  if (error) {
    return (
      <div className="text-(--color-text-muted)">
        Could not load the readiness breakdown.
      </div>
    );
  }

  const present = data.factors.filter((f) => f.present);
  const missing = data.factors.filter((f) => !f.present);

  return (
    <div className="flex flex-col gap-3" data-testid="readiness-drawer">
      <div className="text-sm font-semibold">
        Readiness {data.score}/100 · {data.issue_type}
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <ul className="flex flex-col gap-1" data-testid="readiness-present">
          {present.length === 0 ? (
            <li className="text-(--color-text-muted)">Nothing satisfied yet</li>
          ) : (
            present.map((f) => (
              <li key={f.requirement} className="text-(--type-feature)">
                + {f.requirement} ({f.points})
                {f.evidence ? (
                  <span className="text-(--color-text-muted)"> — {f.evidence}</span>
                ) : null}
              </li>
            ))
          )}
        </ul>
        <ul className="flex flex-col gap-1" data-testid="readiness-missing">
          {missing.length === 0 ? (
            <li className="text-(--color-text-muted)">Everything covered</li>
          ) : (
            missing.map((f) => (
              <li key={f.requirement} className="text-(--type-bug)">
                − {f.requirement} (0/{f.points})
              </li>
            ))
          )}
        </ul>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Wire the column, sort, and drawer into `plan-client.tsx`**

Apply these edits to `frontend/src/app/plan/plan-client.tsx`:

1. Imports — add `Fragment` and `useState` is already imported; add the drawer:
```tsx
import { Fragment, useCallback, useState } from "react";
import { ReadinessDrawer } from "./readiness-drawer";
```

2. `IssueRow` — add the field (after `classification_confidence`):
```tsx
  readiness_score: number | null;
```

3. `SortKey` — add readiness:
```tsx
export type SortKey =
  | "updated"
  | "created"
  | "comments"
  | "number"
  | "title"
  | "readiness";
```

4. `ColumnKey` — add `"ready"` to the union.

5. `COLUMNS` — insert after the `component` entry:
```tsx
  { key: "ready", label: "Ready", sort: "readiness", defaultVisible: true },
```

6. Add the tone helper near `stateBadge`:
```tsx
function readinessTone(score: number): string {
  if (score < 40) return "text-(--type-bug)";
  if (score < 75) return "text-(--type-debt)";
  return "text-(--type-feature)";
}
```

7. Inside `PlanClient`, read `max_readiness` and forward it. After `const component = searchParams.get("component");` add:
```tsx
  const maxReadiness = searchParams.get("max_readiness");
```
After `if (component) backendQuery.set("component", component);` add:
```tsx
  if (maxReadiness) backendQuery.set("max_readiness", maxReadiness);
```

8. Add expand state after the `visible` state:
```tsx
  const [expandedId, setExpandedId] = useState<number | null>(null);
```

9. Pass `maxReadiness` into the `Toolbar` params object (add `maxReadiness` to the object literal passed to `<Toolbar params={{ ... }} />`):
```tsx
          maxReadiness,
```

10. Render the Ready cell and drawer row. Change the row map to return a `Fragment` with the main `<tr>` plus a conditional drawer `<tr>`. Replace `{data.items.map((row) => (` … `</tr>` `))}` so each row is:
```tsx
                {data.items.map((row) => (
                  <Fragment key={row.id}>
                    <tr className="border-b border-(--color-border) last:border-b-0">
                      {/* ...existing repo/number/title/type/component cells unchanged... */}
                      {visible.has("ready") ? (
                        <td className="px-3 py-2" data-testid="ready-cell">
                          {row.readiness_score != null ? (
                            <button
                              type="button"
                              aria-expanded={expandedId === row.id}
                              onClick={() =>
                                setExpandedId(
                                  expandedId === row.id ? null : row.id,
                                )
                              }
                              className={`tabular-nums transition-all duration-150 hover:text-(--color-primary) ${readinessTone(row.readiness_score)}`}
                            >
                              {row.readiness_score}%
                            </button>
                          ) : (
                            <span className="text-(--color-text-muted)">—</span>
                          )}
                        </td>
                      ) : null}
                      {/* ...existing labels/assignees/comments/updated/state/milestone/author/created cells unchanged... */}
                    </tr>
                    {expandedId === row.id ? (
                      <tr className="border-b border-(--color-border) bg-(--accent-tint)">
                        <td colSpan={shownColumns.length} className="px-3 py-3">
                          <ReadinessDrawer issueId={row.id} />
                        </td>
                      </tr>
                    ) : null}
                  </Fragment>
                ))}
```
Place the `ready` cell in column order right after the `component` cell so it lines up with the header. Leave every other `<td>` exactly as it is today.

- [ ] **Step 3: Typecheck and lint**

Run: `cd frontend && npm run lint && npx tsc --noEmit`
Expected: no errors. (If the project uses a different typecheck script, run that; `tsc --noEmit` is the fallback.)

- [ ] **Step 4: Commit**

```bash
git add frontend/src/app/plan/readiness-drawer.tsx frontend/src/app/plan/plan-client.tsx
git commit -m "feat: readiness column and explainable breakdown drawer (#6)"
```

---

### Task 7: Frontend — readiness threshold filter

**Files:**
- Modify: `frontend/src/app/plan/plan-client.tsx` (`TableParams` type)
- Modify: `frontend/src/app/plan/toolbar.tsx`

**Interfaces:**
- Consumes: `max_readiness` URL param plumbing from Task 6.
- Produces: a `Readiness <` `select` control that sets `max_readiness` and resets `offset`.

- [ ] **Step 1: Extend `TableParams`**

In `frontend/src/app/plan/plan-client.tsx`, add to the `TableParams` type (after `component`):
```tsx
  maxReadiness: string | null;
```

- [ ] **Step 2: Add the threshold control to the toolbar**

In `frontend/src/app/plan/toolbar.tsx`:

1. Destructure the new param — update the `const { ... } = params;` line to include `maxReadiness`:
```tsx
  const { repoId, state, label, assignee, q, type, component, maxReadiness, setParams } =
    params;
```

2. Add the threshold options constant near `TYPES`:
```tsx
const READINESS_THRESHOLDS = [
  { value: "", label: "Any readiness" },
  { value: "90", label: "Readiness < 90%" },
  { value: "75", label: "Readiness < 75%" },
  { value: "50", label: "Readiness < 50%" },
  { value: "25", label: "Readiness < 25%" },
];
```

3. Add the control right after the Component `select` (before `<div className="grow" />`):
```tsx
      <select
        aria-label="Readiness"
        className={control}
        value={maxReadiness ?? ""}
        onChange={(e) =>
          setParams({ max_readiness: e.target.value || null, offset: null })
        }
      >
        {READINESS_THRESHOLDS.map((t) => (
          <option key={t.value} value={t.value}>
            {t.label}
          </option>
        ))}
      </select>
```

- [ ] **Step 3: Typecheck and lint**

Run: `cd frontend && npm run lint && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/app/plan/plan-client.tsx frontend/src/app/plan/toolbar.tsx
git commit -m "feat: readiness threshold filter in the plan toolbar (#6)"
```

---

### Task 8: Playwright e2e

**Files:**
- Create: `frontend/e2e/readiness.spec.ts`

**Interfaces:**
- Consumes: the rendered `/plan` page with mocked `issues`, `repositories`, `facets`, and `issues/{id}/readiness` routes.

- [ ] **Step 1: Write the e2e spec**

Create `frontend/e2e/readiness.spec.ts`:

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
  issue_type: "bug",
  component: "auth",
  classification_confidence: 0.9,
  readiness_score: 42,
  ...over,
});

const page1 = {
  items: [
    row({}),
    row({ id: 2, number: 43, title: "Redis rate limiting", readiness_score: 88 }),
  ],
  total: 2,
  limit: 50,
  offset: 0,
};

const repos = [{ id: 500, full_name: "patelmj/mehova" }];
const facets = { labels: [], assignees: [], components: [] };

const breakdown = {
  score: 42,
  issue_type: "bug",
  scored_at: "2026-07-18T00:00:00Z",
  factors: [
    { requirement: "Problem statement", points: 15, present: true, evidence: "crash on login" },
    { requirement: "Reproduction steps", points: 20, present: false, evidence: null },
  ],
};

async function stubList(page, requested?: string[]) {
  await page.route(/\/api\/backend\/repositories$/, (route) => route.fulfill({ json: repos }));
  await page.route(/\/api\/backend\/issues\/facets/, (route) => route.fulfill({ json: facets }));
  await page.route(/\/api\/backend\/issues\/\d+\/readiness$/, (route) =>
    route.fulfill({ json: breakdown }),
  );
  await page.route(/\/api\/backend\/issues\?/, (route) => {
    requested?.push(route.request().url());
    return route.fulfill({ json: page1 });
  });
}

test("readiness column renders and cell expands the breakdown drawer", async ({ page }) => {
  await stubList(page);
  await page.goto("/plan");
  await expect(page.getByRole("columnheader", { name: "Ready" })).toBeVisible();

  const cell = page.getByTestId("ready-cell").first().getByRole("button");
  await expect(async () => {
    await cell.click();
    await expect(page.getByTestId("readiness-drawer")).toBeVisible();
  }).toPass();

  await expect(page.getByTestId("readiness-present")).toContainText("Problem statement");
  await expect(page.getByTestId("readiness-missing")).toContainText("Reproduction steps");
});

test("readiness threshold filter round-trips to the API and URL", async ({ page }) => {
  const requested: string[] = [];
  await stubList(page, requested);
  await page.goto("/plan");
  await expect(page.getByText("Fix token refresh")).toBeVisible();

  await page.getByLabel("Readiness", { exact: true }).selectOption("75");
  await expect(page).toHaveURL(/max_readiness=75/);
  await expect
    .poll(() => requested.some((u) => u.includes("max_readiness=75")))
    .toBe(true);
});
```

- [ ] **Step 2: Restart the frontend dev container to clear stale builds**

Run: `docker restart issuelens-frontend-1`
(Gotcha: the dockerized dev server serves stale builds; restart before e2e.)

- [ ] **Step 3: Run the e2e spec**

Run: `cd frontend && npx playwright test e2e/readiness.spec.ts`
Expected: PASS (2 tests). If a hydration race flakes a click, confirm the `expect(...).toPass()` wrapper is in place.

- [ ] **Step 4: Commit**

```bash
git add frontend/e2e/readiness.spec.ts
git commit -m "test: e2e for readiness column, drawer, and threshold filter (#6)"
```

---

### Task 9: Live verification + final whole-branch review

**Files:** none (verification only).

- [ ] **Step 1: Full backend suite + lint**

Run: `cd backend && uv run pytest -q && uv run ruff check app tests worker.py`
Expected: all green.

- [ ] **Step 2: Migrate and bring up the live stack**

Run: `docker compose up -d` then `cd backend && uv run alembic upgrade head` (or the containerized equivalent already used in this project). Confirm `alembic current` → `0005 (head)`.

- [ ] **Step 3: Drive the real pipeline against a dogfood repo**

Trigger a sync for a connected repo (the same mechanism used to verify slice 5), then confirm the chain ran:
- `SyncJob` rows of `kind="classify"` then `kind="readiness"` reach `status="success"`.
- Query `SELECT count(*), min(score), max(score) FROM issue_readiness;` — expect a populated table with scores in `[0,100]`.
- Spot-check one row's `factors` JSON: present items' points sum to `score`.

- [ ] **Step 4: Verify the UI end-to-end (Playwright CLI against the live app)**

Load `/plan`, confirm the `Ready` column shows real percentages, click a cell to expand the drawer and confirm the +/- factors render, and apply the `Readiness < 75%` filter to confirm the table narrows. (Restart `issuelens-frontend-1` first if the build looks stale.)

- [ ] **Step 5: Dispatch the final whole-branch review**

Per CLAUDE.md house tiering, run the final whole-branch review on the most-capable model (not the session default by accident). Feed it the full diff of `feat/readiness-scoring` vs `main`. Address findings in a single fix wave, then re-review the fix diff. Track state in `.superpowers/sdd/progress.md`.

- [ ] **Step 6: Pause for the PR decision**

Do NOT open a PR automatically. Surface a summary of what shipped and ask the user whether to open a PR for review (CLAUDE.md PR-based review methodology).

---

## Self-Review

**Spec coverage:**
- §6 type-specific evaluation → Task 1 `RUBRICS` (5 rubrics) + Task 3 rubric selection by `classification.issue_type`. ✓
- §6.1–6.3 verbatim point tables → Task 1 (bug/feature/debt sums asserted = 100). ✓
- §6.4 explainable +/- result → Task 3 `factors` storage + Task 5 breakdown endpoint + Task 6 drawer. ✓
- §6.4 diff / approve / push → explicitly OUT (deferred to #7); noted in Global Constraints + Task 9 summary. ✓
- §7.1 `Readiness score` column → Task 6 `ready` column. ✓
- §7 `Readiness < N` filter → Task 5 `max_readiness` + Task 7 toolbar control. ✓
- Staleness (body change + reclassification) → Task 2 snapshot columns + Task 3 `stale_readiness_query` (3 triggers) + Task 3 tests. ✓
- Pipeline integration (chain + cron) → Task 4. ✓
- Two new docs/question rubrics → Task 1 (both asserted = 100). ✓

**Placeholder scan:** No TBD/TODO; every code step carries complete code; every test step carries assertions; commands have expected output. The only deferred detail is exact drawer color tokens, and the plan supplies working defaults (`--type-*` tokens) — implementable as-is.

**Type consistency:** `score_readiness(client, prompt, requirement_ids)` — same 3-arg signature in Task 1 definition, Task 1 tests, and Task 3 call site. `factors` dict keys (`requirement`/`points`/`present`/`evidence`) match across Task 3 producer, Task 5 `FactorOut`, and Task 6 `Factor`. `stale_readiness_query` returns `(Issue, IssueClassification)` in Task 3 definition and is unpacked as `issue, classification` / `issue, _cls` consistently. `readiness_score` field name matches across Task 5 `IssueOut`, Task 6 `IssueRow`, and the e2e fixture. Dedupe key `readiness-{repo_id}` identical in Task 4 chain, sweep, and tests.
