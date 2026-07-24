# Triage Suggestion v2 Implementation Plan (#56 + #57)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** AI-drafted answers for missing template sections (grounded-only, pre-generated during sync) presented in a side-by-side original/proposed drawer with per-section regenerate/steer/edit/remove.

**Architecture:** `IssueSuggestion` gains a structured `sections` JSONB (per-section provenance) and `drafted_at`; `proposed_body` becomes derived (base + sections + footnote) so the push/conflict flow is untouched. A new Ollama call drafts all missing sections in one bulk request during the sync pipeline (after priority scoring); a targeted single-section call serves regenerate/steer. The drawer is rewritten as rendered-markdown side-by-side panes (spec variant D1) that stack to an inline flow below 720px.

**Tech Stack:** FastAPI + SQLAlchemy async + Alembic + arq; Ollama structured output (JSON-schema `format`); Next.js App Router + React Query + react-markdown/remark-gfm + Tailwind v4; pytest + respx; Playwright.

**Spec:** `docs/superpowers/specs/2026-07-24-triage-suggestion-v2-design.md` — read it before starting any task.

## Global Constraints

- Branch: `feat/triage-suggestion-v2` (created off `spec/triage-analytics-56-57-58`).
- Commit messages: NO author attribution tags, model identifiers, or Co-Authored-By lines.
- Backend verify: `cd backend && ruff check . && python -m pytest tests/ -q` (needs local Postgres+Redis from `docker compose up -d db redis`).
- Frontend verify: `cd frontend && npm run lint`. E2e: `npx playwright test e2e/triage.spec.ts` (needs the dev stack).
- Tailwind v4: CSS custom properties use PARENTHESES syntax `bg-(--color-X)`, never brackets `bg-[--color-X]`.
- Frontend: this Next.js version differs from training data — read the relevant guide in `frontend/node_modules/next/dist/docs/` before writing app-router code.
- No new dependencies (react-markdown + remark-gfm already installed).
- Section JSON shape (used everywhere): `{"requirement_id": str, "heading": str, "body_md": str, "origin": "ai"|"scaffold", "model": str|null, "edited": bool, "removed": bool, "stale": bool}`.
- Footnote format (exact): `---\n*Sections "A" and "B" drafted by <model> from the existing report — please confirm or correct.*`
- When a task says "grep for all call sites", actually run the grep — do not rely on the lists in this plan being exhaustive.

---

### Task 1: Migration + model columns (`sections`, `drafted_at`)

**Files:**
- Create: `backend/alembic/versions/0013_suggestion_sections.py`
- Modify: `backend/app/models.py` (class `IssueSuggestion`, after the `edited` column)

**Interfaces:**
- Produces: `IssueSuggestion.sections: list | None` (JSONB), `IssueSuggestion.drafted_at: datetime | None`. Later tasks read/write both.

- [ ] **Step 1: Write the migration**

```python
"""suggestion sections + drafted_at

Revision ID: 0013
Revises: 0012
Create Date: 2026-07-24
"""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import JSONB

revision = "0013"
down_revision = "0012"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "issue_suggestions",
        sa.Column("sections", JSONB(), nullable=True),
    )
    op.add_column(
        "issue_suggestions",
        sa.Column("drafted_at", sa.DateTime(timezone=True), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("issue_suggestions", "drafted_at")
    op.drop_column("issue_suggestions", "sections")
```

First check the actual revision ids: `grep -l "revision = " backend/alembic/versions/0012_repository_visible.py` and open it — use its literal `revision` value as `down_revision` here (the file names are numbered but the ids may be hex strings; copy verbatim).

- [ ] **Step 2: Add the model columns**

In `backend/app/models.py`, inside `class IssueSuggestion`, after the `edited` column:

```python
    sections: Mapped[list | None] = mapped_column(JSONB, nullable=True)
    drafted_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
```

- [ ] **Step 3: Run migration + full backend tests**

Run: `cd backend && python -m alembic upgrade head && python -m pytest tests/ -q`
Expected: upgrade applies cleanly; all existing tests pass (test DB migrates in conftest).

- [ ] **Step 4: Commit**

```bash
git add backend/alembic/versions/0013_suggestion_sections.py backend/app/models.py
git commit -m "feat: sections JSONB + drafted_at on issue_suggestions"
```

---

### Task 2: Section composition module

**Files:**
- Create: `backend/app/triage/sections.py`
- Test: `backend/tests/test_triage_sections.py`

**Interfaces:**
- Consumes: `SCAFFOLDS` from `app.triage.scaffold`.
- Produces:
  - `scaffold_section(requirement_id: str) -> dict` — a scaffold-origin section dict.
  - `compose_proposed_body(base_body: str, sections: list[dict]) -> str` — derived body incl. footnote.
  - `footnote(sections: list[dict]) -> str | None`.

- [ ] **Step 1: Write the failing tests**

```python
from app.triage.sections import compose_proposed_body, footnote, scaffold_section


def ai_section(rid="repro_steps", heading="Reproduction Steps", body="1. Go to /login",
               model="qwen3:8b", edited=False, removed=False, stale=False):
    return {"requirement_id": rid, "heading": heading, "body_md": body,
            "origin": "ai", "model": model, "edited": edited,
            "removed": removed, "stale": stale}


def test_scaffold_section_splits_heading_from_body():
    s = scaffold_section("repro_steps")
    assert s["requirement_id"] == "repro_steps"
    assert s["heading"] == "Reproduction Steps"
    assert s["origin"] == "scaffold"
    assert s["model"] is None
    assert s["edited"] is False and s["removed"] is False and s["stale"] is False
    assert "## " not in s["body_md"]            # heading lives in the heading field
    assert "<!-- Minimal steps to reproduce -->" in s["body_md"]


def test_compose_appends_sections_with_headings():
    body = compose_proposed_body("original text", [scaffold_section("environment")])
    assert body.startswith("original text")
    assert "\n## Environment\n" in body


def test_compose_skips_removed_sections():
    s = scaffold_section("environment")
    s["removed"] = True
    assert "Environment" not in compose_proposed_body("orig", [s])


def test_footnote_absent_without_ai_sections():
    assert footnote([scaffold_section("environment")]) is None
    assert "please confirm" not in compose_proposed_body("orig", [scaffold_section("environment")])


def test_footnote_names_ai_sections_and_model():
    note = footnote([ai_section(), scaffold_section("environment")])
    assert note.startswith("---\n*Sections")
    assert '"Reproduction Steps"' in note
    assert "qwen3:8b" in note
    assert note.endswith("please confirm or correct.*")


def test_footnote_joins_two_names_with_and():
    two = [ai_section(), ai_section(rid="expected_behavior", heading="Expected Behavior")]
    note = footnote(two)
    assert '"Reproduction Steps" and "Expected Behavior"' in note


def test_footnote_excludes_removed_ai_sections():
    s = ai_section()
    s["removed"] = True
    assert footnote([s]) is None


def test_compose_empty_base_has_no_leading_gap():
    body = compose_proposed_body("", [scaffold_section("environment")])
    assert body.startswith("## Environment")
```

- [ ] **Step 2: Run to verify failure**

Run: `cd backend && python -m pytest tests/test_triage_sections.py -q`
Expected: FAIL — `ModuleNotFoundError: app.triage.sections`

- [ ] **Step 3: Implement**

```python
"""Structured suggestion sections and server-side body composition.

A section dict: {requirement_id, heading, body_md, origin: "ai"|"scaffold",
model, edited, removed, stale}. proposed_body is always derived here so the
push flow never needs to know about sections.
"""

from app.triage.scaffold import SCAFFOLDS


def scaffold_section(requirement_id: str) -> dict:
    scaffold = SCAFFOLDS[requirement_id]
    first_line, _, rest = scaffold.partition("\n")
    return {
        "requirement_id": requirement_id,
        "heading": first_line.lstrip("#").strip(),
        "body_md": rest.rstrip("\n"),
        "origin": "scaffold",
        "model": None,
        "edited": False,
        "removed": False,
        "stale": False,
    }


def footnote(sections: list[dict]) -> str | None:
    ai = [s for s in sections if not s["removed"] and s["origin"] == "ai"]
    if not ai:
        return None
    names = [f'"{s["heading"]}"' for s in ai]
    joined = names[0] if len(names) == 1 else ", ".join(names[:-1]) + " and " + names[-1]
    models = ", ".join(sorted({s["model"] for s in ai if s["model"]}))
    return (
        f"---\n*Sections {joined} drafted by {models} from the existing report"
        " — please confirm or correct.*"
    )


def compose_proposed_body(base_body: str, sections: list[dict]) -> str:
    body = base_body or ""
    for section in sections:
        if section["removed"]:
            continue
        separator = "" if body == "" else ("\n" if body.endswith("\n") else "\n\n")
        body = f"{body}{separator}## {section['heading']}\n{section['body_md']}\n"
    note = footnote(sections)
    if note is not None:
        separator = "\n" if body.endswith("\n") else "\n\n"
        body = f"{body}{separator}{note}\n"
    return body
```

- [ ] **Step 4: Run tests**

Run: `cd backend && python -m pytest tests/test_triage_sections.py -q`
Expected: all PASS

- [ ] **Step 5: Commit**

```bash
git add backend/app/triage/sections.py backend/tests/test_triage_sections.py
git commit -m "feat: section composition with AI-draft footnote"
```

---

### Task 3: Ollama draft call (`app/llm/draft.py`)

**Files:**
- Create: `backend/app/llm/draft.py`
- Test: `backend/tests/test_llm_draft.py`

**Interfaces:**
- Consumes: `make_ollama_client`, `get_settings().ollama_model` (same pattern as `classify` in `app/llm/ollama.py`).
- Produces:
  - `draft_schema(requirement_ids: list[str]) -> dict`
  - `class DraftError(Exception)`
  - `async draft_sections(client, prompt: str, requirement_ids: list[str]) -> dict[str, dict]` — `{rid: {"grounded": bool, "body_md": str}}`
  - `build_draft_prompt(issue_type, title, labels, body, comments, repo_card, references, requirements, steer=None) -> str` — `requirements` is `[(rid, label)]`.
  - Constants: `MAX_DRAFT_CHARS = 2000`, `MAX_BODY_CHARS = 4000`, `MAX_COMMENT_CHARS = 500`.

- [ ] **Step 1: Write the failing tests**

```python
import httpx
import json

import pytest
import respx

from app.llm.draft import (
    DraftError,
    build_draft_prompt,
    draft_schema,
    draft_sections,
)


def make_client():
    return httpx.AsyncClient(base_url="http://ollama.test")


def chat_response(payload: dict):
    return httpx.Response(200, json={"message": {"content": json.dumps(payload)}})


def test_schema_keys_match_requirements():
    schema = draft_schema(["repro_steps", "environment"])
    assert set(schema["properties"]) == {"repro_steps", "environment"}
    assert schema["required"] == ["repro_steps", "environment"]
    section = schema["properties"]["repro_steps"]
    assert section["required"] == ["grounded", "body_md"]


def test_prompt_contains_context_and_grounding_rule():
    prompt = build_draft_prompt(
        issue_type="bug",
        title="Login clears email",
        labels=["bug"],
        body="the field wipes",
        comments=["only in Safari"],
        repo_card="o/r — auth service (primary language: Python)",
        references=["#12: Session bug (open)"],
        requirements=[("repro_steps", "Reproduction steps")],
    )
    assert "Login clears email" in prompt
    assert "only in Safari" in prompt
    assert "auth service" in prompt
    assert "#12: Session bug (open)" in prompt
    assert '"repro_steps": Reproduction steps' in prompt
    assert "never invent" in prompt


def test_prompt_appends_steer_when_given():
    prompt = build_draft_prompt(
        issue_type="bug", title="t", labels=[], body="b", comments=[],
        repo_card="o/r", references=[],
        requirements=[("repro_steps", "Reproduction steps")],
        steer="Mention this only reproduces in Safari.",
    )
    assert "The user adds: Mention this only reproduces in Safari." in prompt


@respx.mock
@pytest.mark.asyncio
async def test_draft_sections_normalizes_grounded_output(pin_env):
    respx.post("http://ollama.test/api/chat").mock(
        return_value=chat_response(
            {
                "repro_steps": {"grounded": True, "body_md": "1. Go to /login"},
                "environment": {"grounded": False, "body_md": ""},
            }
        )
    )
    async with make_client() as client:
        result = await draft_sections(client, "prompt", ["repro_steps", "environment"])
    assert result["repro_steps"] == {"grounded": True, "body_md": "1. Go to /login"}
    assert result["environment"]["grounded"] is False


@respx.mock
@pytest.mark.asyncio
async def test_grounded_true_with_empty_body_becomes_ungrounded(pin_env):
    respx.post("http://ollama.test/api/chat").mock(
        return_value=chat_response({"repro_steps": {"grounded": True, "body_md": "   "}})
    )
    async with make_client() as client:
        result = await draft_sections(client, "p", ["repro_steps"])
    assert result["repro_steps"]["grounded"] is False


@respx.mock
@pytest.mark.asyncio
async def test_missing_requirement_defaults_ungrounded(pin_env):
    respx.post("http://ollama.test/api/chat").mock(return_value=chat_response({}))
    async with make_client() as client:
        result = await draft_sections(client, "p", ["repro_steps"])
    assert result["repro_steps"] == {"grounded": False, "body_md": ""}


@respx.mock
@pytest.mark.asyncio
async def test_non_json_raises_draft_error(pin_env):
    respx.post("http://ollama.test/api/chat").mock(
        return_value=httpx.Response(200, json={"message": {"content": "not json"}})
    )
    async with make_client() as client:
        with pytest.raises(DraftError):
            await draft_sections(client, "p", ["repro_steps"])
```

Note: `pin_env` is the autouse conftest fixture — naming it as a parameter is unnecessary but harmless; keep the signatures as written only if `pytest` complains otherwise drop the parameter. Check how `tests/test_classify.py` handles this and mirror it exactly.

- [ ] **Step 2: Run to verify failure**

Run: `cd backend && python -m pytest tests/test_llm_draft.py -q`
Expected: FAIL — `ModuleNotFoundError: app.llm.draft`

- [ ] **Step 3: Implement**

```python
import json
import logging
from typing import Any

import httpx

from app.config import get_settings

logger = logging.getLogger(__name__)

MAX_DRAFT_CHARS = 2000
MAX_BODY_CHARS = 4000
MAX_COMMENT_CHARS = 500


class DraftError(Exception):
    """The model returned output we could not use for section drafting."""


def draft_schema(requirement_ids: list[str]) -> dict[str, Any]:
    return {
        "type": "object",
        "properties": {
            rid: {
                "type": "object",
                "properties": {
                    "grounded": {"type": "boolean"},
                    "body_md": {"type": "string"},
                },
                "required": ["grounded", "body_md"],
            }
            for rid in requirement_ids
        },
        "required": list(requirement_ids),
    }


PROMPT_TEMPLATE = """You are helping complete a GitHub {issue_type} issue that is \
missing template sections.

Draft content ONLY when the context below clearly supports it. Prefer quoting or \
tightly paraphrasing the reporter's own words. If the context does not contain the \
information a section needs, return "grounded": false with an empty "body_md" — \
never invent or guess.

Repository: {repo_card}
Issue title: {title}
Issue labels: {labels}
Issue body:
{body}

Recent comments (oldest first):
{comments}

Issues referenced in the thread:
{references}

Missing sections to draft — return one object per key:
{requirements}

For each section return:
- "grounded": true only if the context above contains the information for it.
- "body_md": the drafted markdown content for that section (do NOT repeat the \
section heading), or "" when grounded is false.
{steer}"""


def build_draft_prompt(
    issue_type: str,
    title: str,
    labels: list[str],
    body: str,
    comments: list[str],
    repo_card: str,
    references: list[str],
    requirements: list[tuple[str, str]],
    steer: str | None = None,
) -> str:
    comment_lines = "\n".join(
        f"- {c[:MAX_COMMENT_CHARS]}" for c in comments if c.strip()
    ) or "(none)"
    reference_lines = "\n".join(f"- {r}" for r in references) or "(none)"
    requirement_lines = "\n".join(f'- "{rid}": {label}' for rid, label in requirements)
    steer_line = f"\nThe user adds: {steer}" if steer else ""
    return PROMPT_TEMPLATE.format(
        issue_type=issue_type,
        repo_card=repo_card,
        title=title,
        labels=", ".join(labels) or "none",
        body=(body or "")[:MAX_BODY_CHARS] or "(empty)",
        comments=comment_lines,
        references=reference_lines,
        requirements=requirement_lines,
        steer=steer_line,
    )


def _normalize_drafts(raw: Any, requirement_ids: list[str]) -> dict[str, dict]:
    if not isinstance(raw, dict):
        raise DraftError(f"expected object, got {type(raw).__name__}")
    result: dict[str, dict] = {}
    for rid in requirement_ids:
        item = raw.get(rid)
        if not isinstance(item, dict):
            result[rid] = {"grounded": False, "body_md": ""}
            continue
        body_md = item.get("body_md")
        body_md = body_md.strip()[:MAX_DRAFT_CHARS] if isinstance(body_md, str) else ""
        grounded = bool(item.get("grounded", False)) and bool(body_md)
        result[rid] = {"grounded": grounded, "body_md": body_md if grounded else ""}
    return result


async def draft_sections(
    client: httpx.AsyncClient, prompt: str, requirement_ids: list[str]
) -> dict[str, dict]:
    resp = await client.post(
        "/api/chat",
        json={
            "model": get_settings().ollama_model,
            "messages": [{"role": "user", "content": prompt}],
            "stream": False,
            "think": False,
            "format": draft_schema(requirement_ids),
            "options": {"temperature": 0},
        },
    )
    resp.raise_for_status()
    content = resp.json()["message"]["content"]
    try:
        raw = json.loads(content)
    except json.JSONDecodeError as exc:
        raise DraftError(f"model returned non-JSON: {content[:200]!r}") from exc
    return _normalize_drafts(raw, requirement_ids)
```

- [ ] **Step 4: Run tests**

Run: `cd backend && python -m pytest tests/test_llm_draft.py -q`
Expected: all PASS

- [ ] **Step 5: Commit**

```bash
git add backend/app/llm/draft.py backend/tests/test_llm_draft.py
git commit -m "feat: grounded-only Ollama section drafting call"
```

---

### Task 4: Draft context gathering (`app/triage/context.py`)

**Files:**
- Create: `backend/app/triage/context.py`
- Test: `backend/tests/test_triage_context.py`

**Interfaces:**
- Consumes: `installation_get_one`, `installation_get_paginated` from `app.github.client`; `Issue`, `Repository` models.
- Produces: `async gather_draft_context(session, gh_client, issue, repo) -> dict` with keys `comments: list[str]`, `repo_card: str`, `references: list[str]`. Degrades gracefully (empty comments / bare repo card / empty references) on ANY GitHub failure — drafting must work offline from mirror data alone.
- Constants: `MAX_COMMENTS = 20`, `MAX_REFERENCED_ISSUES = 10`.

- [ ] **Step 1: Write the failing tests**

Seed helpers are self-contained (do not import seeds from other test files). Reuse the `app_creds` fixture from `tests.test_github_auth` for token plumbing and mock GitHub with respx — mirror the mocking style used in `tests/test_github_write.py` (open it first and copy its token-endpoint mock verbatim).

```python
from datetime import datetime, timezone

import pytest
import respx
from httpx import Response

from app.db import get_sessionmaker
from app.github.client import make_http_client
from app.models import Installation, Issue, Repository
from app.triage.context import gather_draft_context
from tests.test_github_auth import app_creds  # noqa: F401

NOW = datetime(2026, 7, 24, tzinfo=timezone.utc)


async def seed(session):
    session.add(Installation(id=42, account_login="o"))
    repo = Repository(id=1, installation_id=42, full_name="o/r", owner="o", name="r")
    session.add(repo)
    issue = Issue(
        id=1, repository_id=1, number=7, title="Login clears email",
        body="same as #12", state="open", gh_created_at=NOW, gh_updated_at=NOW,
    )
    session.add(issue)
    session.add(
        Issue(
            id=2, repository_id=1, number=12, title="Session bug", body="",
            state="closed", gh_created_at=NOW, gh_updated_at=NOW, gh_closed_at=NOW,
        )
    )
    await session.commit()
    return issue, repo


@respx.mock
async def test_gathers_comments_repo_card_and_references(clean_db, app_creds):  # noqa: F811
    respx.post("https://api.github.com/app/installations/42/access_tokens").mock(
        return_value=Response(201, json={"token": "t", "expires_at": "2099-01-01T00:00:00Z"})
    )
    respx.get("https://api.github.com/repos/o/r/issues/7/comments").mock(
        return_value=Response(200, json=[{"body": "also see #12, only in Safari"}])
    )
    respx.get("https://api.github.com/repos/o/r").mock(
        return_value=Response(200, json={"description": "auth service", "language": "Python"})
    )
    async with get_sessionmaker()() as session:
        issue, repo = await seed(session)
        async with make_http_client() as client:
            ctx = await gather_draft_context(session, client, issue, repo)
    assert ctx["comments"] == ["also see #12, only in Safari"]
    assert ctx["repo_card"] == "o/r — auth service (primary language: Python)"
    assert ctx["references"] == ["#12: Session bug (closed)"]


@respx.mock
async def test_degrades_to_mirror_only_on_github_failure(clean_db, app_creds):  # noqa: F811
    respx.post("https://api.github.com/app/installations/42/access_tokens").mock(
        return_value=Response(500)
    )
    async with get_sessionmaker()() as session:
        issue, repo = await seed(session)
        async with make_http_client() as client:
            ctx = await gather_draft_context(session, client, issue, repo)
    assert ctx["comments"] == []
    assert ctx["repo_card"] == "o/r"
    # references still resolve from the mirror (body text needs no API call)
    assert ctx["references"] == ["#12: Session bug (closed)"]


async def test_reference_to_self_and_unknown_numbers_skipped(clean_db):
    async with get_sessionmaker()() as session:
        issue, repo = await seed(session)
        issue.body = "see #7 and #999 and #12"
        await session.commit()
        ctx_refs = (
            await gather_draft_context(session, None, issue, repo)
        )["references"]
    assert ctx_refs == ["#12: Session bug (closed)"]
```

Note the third test passes `gh_client=None` — the implementation must treat `None` as "skip GitHub calls entirely" (used by unit paths and offline degradation).

- [ ] **Step 2: Run to verify failure**

Run: `cd backend && python -m pytest tests/test_triage_context.py -q`
Expected: FAIL — `ModuleNotFoundError: app.triage.context`

- [ ] **Step 3: Implement**

```python
import logging
import re

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.github.client import installation_get_one, installation_get_paginated
from app.models import Issue, Repository

logger = logging.getLogger(__name__)

MAX_COMMENTS = 20
MAX_REFERENCED_ISSUES = 10

_REF_PATTERN = re.compile(r"#(\d+)")


async def _fetch_comments(gh_client, repo: Repository, issue: Issue) -> list[str]:
    if gh_client is None:
        return []
    try:
        raw = await installation_get_paginated(
            gh_client,
            repo.installation_id,
            f"/repos/{repo.full_name}/issues/{issue.number}/comments",
        )
    except Exception:
        logger.warning(
            "comment fetch failed for %s#%s; drafting from mirror only",
            repo.full_name, issue.number, exc_info=True,
        )
        return []
    return [c.get("body") or "" for c in raw[-MAX_COMMENTS:]]


async def _fetch_repo_card(gh_client, repo: Repository) -> str:
    if gh_client is None:
        return repo.full_name
    try:
        meta = await installation_get_one(
            gh_client, repo.installation_id, f"/repos/{repo.full_name}"
        )
    except Exception:
        logger.warning(
            "repo metadata fetch failed for %s; using bare name",
            repo.full_name, exc_info=True,
        )
        return repo.full_name
    description = meta.get("description") or "no description"
    language = meta.get("language") or "unknown"
    return f"{repo.full_name} — {description} (primary language: {language})"


async def _resolve_references(
    session: AsyncSession, repo: Repository, issue: Issue, texts: list[str]
) -> list[str]:
    numbers = {
        int(m) for text in texts for m in _REF_PATTERN.findall(text or "")
    } - {issue.number}
    if not numbers:
        return []
    rows = (
        await session.execute(
            select(Issue.number, Issue.title, Issue.state)
            .where(
                Issue.repository_id == repo.id,
                Issue.number.in_(sorted(numbers)[:MAX_REFERENCED_ISSUES]),
            )
            .order_by(Issue.number)
        )
    ).all()
    return [f"#{number}: {title} ({state})" for number, title, state in rows]


async def gather_draft_context(
    session: AsyncSession, gh_client, issue: Issue, repo: Repository
) -> dict:
    comments = await _fetch_comments(gh_client, repo, issue)
    repo_card = await _fetch_repo_card(gh_client, repo)
    references = await _resolve_references(
        session, repo, issue, [issue.body or "", *comments]
    )
    return {"comments": comments, "repo_card": repo_card, "references": references}
```

- [ ] **Step 4: Run tests**

Run: `cd backend && python -m pytest tests/test_triage_context.py -q`
Expected: all PASS. If the respx token mock 404s, open `tests/test_github_write.py` and copy its exact token URL/mock shape.

- [ ] **Step 5: Commit**

```bash
git add backend/app/triage/context.py backend/tests/test_triage_context.py
git commit -m "feat: draft context gathering with graceful GitHub degradation"
```

---

### Task 5: Drafting service (`app/triage/drafting.py`)

**Files:**
- Create: `backend/app/triage/drafting.py`
- Test: `backend/tests/test_triage_drafting.py`

**Interfaces:**
- Consumes: `draft_sections`, `build_draft_prompt` (Task 3); `gather_draft_context` (Task 4); `scaffold_section`, `compose_proposed_body` (Task 2); `missing_requirements` from `app.triage.service`; `RUBRICS` from `app.llm.readiness`.
- Produces:
  - `async draft_issue_suggestion(session, ollama_client, gh_client, issue_id) -> IssueSuggestion` — full (re)draft of one issue's suggestion.
  - `async regenerate_section(session, ollama_client, gh_client, issue_id, requirement_id, steer=None) -> IssueSuggestion`
  - `async patch_section(session, issue_id, requirement_id, body_md=None, removed=None) -> IssueSuggestion`
  - `async draft_repository_suggestions(session, ollama_client, gh_client, repo_id) -> int` — repo sweep with `SyncJob(kind="draft")` bookkeeping.
  - `DRAFT_THRESHOLD = 80`
  - Raises the exceptions already defined in `app.triage.service` (`SuggestionNotFound`, `SuggestionConflict`) plus a new `SectionNotFound(Exception)` defined here.

**Behavior rules (from spec §2/§4 — implement exactly):**
- Rebuild sections from the CURRENT missing-requirements list. Preserve existing entries (their `edited`/`removed`/body) whose rid is still missing; drop rids no longer missing; add new rids.
- An existing `edited` section is never overwritten by a redraft; if the base body changed since the suggestion snapshot, mark it `stale: true` instead. Un-edited sections are redrafted freely.
- Skip drafting entirely when suggestion status is `pushed` or `rejected` (raise `SuggestionConflict` from `draft_issue_suggestion`; silently skip in the repo sweep).
- After any section change, recompose `proposed_body` and set `drafted_at = func.now()` (only `draft_issue_suggestion` and `regenerate_section` set `drafted_at`; `patch_section` does not).
- `regenerate_section` clears `edited`/`stale` on that section and sets origin per the grounded result.
- `patch_section(body_md=...)` sets `edited=True, stale=False, origin` unchanged; `patch_section(removed=...)` toggles `removed`.

- [ ] **Step 1: Write the failing tests**

Self-contained ORM seeds; Ollama mocked with respx (no GitHub client → pass `gh_client=None` so context degrades to mirror-only; that path is already tested in Task 4).

```python
import json
from datetime import datetime, timedelta, timezone

import pytest
import respx
from httpx import Response

from app.db import get_sessionmaker
from app.llm.ollama import make_ollama_client
from app.models import (
    Installation, Issue, IssueClassification, IssueReadiness, IssueSuggestion,
    Repository, SyncJob,
)
from app.triage import service
from app.triage.drafting import (
    SectionNotFound,
    draft_issue_suggestion,
    draft_repository_suggestions,
    patch_section,
    regenerate_section,
)

NOW = datetime(2026, 7, 24, tzinfo=timezone.utc)
OLLAMA = "http://127.0.0.1:11434"


def chat(payload):
    return Response(200, json={"message": {"content": json.dumps(payload)}})


def mock_tags():
    respx.get(f"{OLLAMA}/api/tags").mock(
        return_value=Response(200, json={"models": [{"name": "test-model"}]})
    )


async def seed(session, score=42):
    session.add(Installation(id=42, account_login="o"))
    session.add(Repository(id=1, installation_id=42, full_name="o/r", owner="o", name="r"))
    session.add(
        Issue(
            id=1, repository_id=1, number=7, title="Login clears email",
            body="Enter a wrong password on /login and the email field is wiped.",
            state="open", gh_created_at=NOW, gh_updated_at=NOW,
        )
    )
    session.add(
        IssueClassification(
            issue_id=1, issue_type="bug", component="auth", confidence=0.9,
            model="test-model", issue_gh_updated_at=NOW,
        )
    )
    # factors mark repro_steps and environment absent, everything else present
    factors = [
        {"requirement": "Problem statement", "points": 15, "present": True, "evidence": "x"},
        {"requirement": "Expected behavior", "points": 15, "present": True, "evidence": "x"},
        {"requirement": "Actual behavior", "points": 15, "present": True, "evidence": "x"},
        {"requirement": "Reproduction steps", "points": 20, "present": False, "evidence": None},
        {"requirement": "Environment or version", "points": 10, "present": False, "evidence": None},
        {"requirement": "Logs, screenshots, or error output", "points": 10, "present": True, "evidence": "x"},
        {"requirement": "Severity or impact", "points": 10, "present": True, "evidence": "x"},
        {"requirement": "Ownership or category", "points": 5, "present": True, "evidence": "x"},
    ]
    session.add(
        IssueReadiness(
            issue_id=1, issue_type="bug", score=score, factors=factors,
            model="test-model", issue_gh_updated_at=NOW, classification_scored_at=NOW,
        )
    )
    await session.commit()


@respx.mock
async def test_draft_creates_sections_with_grounded_and_scaffold(clean_db):
    mock_tags()
    respx.post(f"{OLLAMA}/api/chat").mock(
        return_value=chat({
            "repro_steps": {"grounded": True, "body_md": "1. Go to /login\n2. Wrong password"},
            "environment": {"grounded": False, "body_md": ""},
        })
    )
    async with get_sessionmaker()() as session:
        await seed(session)
        async with make_ollama_client() as ollama:
            sug = await draft_issue_suggestion(session, ollama, None, 1)
    by_rid = {s["requirement_id"]: s for s in sug.sections}
    assert by_rid["repro_steps"]["origin"] == "ai"
    assert by_rid["repro_steps"]["model"] == "test-model"
    assert by_rid["environment"]["origin"] == "scaffold"
    assert sug.drafted_at is not None
    assert "1. Go to /login" in sug.proposed_body
    assert "drafted by test-model" in sug.proposed_body


@respx.mock
async def test_redraft_preserves_edited_sections_and_flags_stale(clean_db):
    mock_tags()
    respx.post(f"{OLLAMA}/api/chat").mock(
        return_value=chat({
            "repro_steps": {"grounded": True, "body_md": "fresh draft"},
            "environment": {"grounded": False, "body_md": ""},
        })
    )
    async with get_sessionmaker()() as session:
        await seed(session)
        async with make_ollama_client() as ollama:
            await draft_issue_suggestion(session, ollama, None, 1)
            await patch_section(session, 1, "repro_steps", body_md="my own words")
            # simulate the issue changing on GitHub after the snapshot
            issue = await session.get(Issue, 1)
            issue.body = "changed body"
            issue.gh_updated_at = NOW + timedelta(hours=1)
            await session.commit()
            sug = await draft_issue_suggestion(session, ollama, None, 1)
    by_rid = {s["requirement_id"]: s for s in sug.sections}
    assert by_rid["repro_steps"]["body_md"] == "my own words"
    assert by_rid["repro_steps"]["edited"] is True
    assert by_rid["repro_steps"]["stale"] is True
    assert sug.base_body == "changed body"


@respx.mock
async def test_draft_refuses_pushed_suggestion(clean_db):
    mock_tags()
    async with get_sessionmaker()() as session:
        await seed(session)
        await service.generate_suggestion(session, 1)
        sug = await service.get_suggestion(session, 1)
        sug.status = "pushed"
        await session.commit()
        async with make_ollama_client() as ollama:
            with pytest.raises(service.SuggestionConflict):
                await draft_issue_suggestion(session, ollama, None, 1)


@respx.mock
async def test_regenerate_section_with_steer_updates_one_section(clean_db):
    mock_tags()
    respx.post(f"{OLLAMA}/api/chat").mock(
        side_effect=[
            chat({
                "repro_steps": {"grounded": True, "body_md": "first"},
                "environment": {"grounded": False, "body_md": ""},
            }),
            chat({"repro_steps": {"grounded": True, "body_md": "steered draft"}}),
        ]
    )
    async with get_sessionmaker()() as session:
        await seed(session)
        async with make_ollama_client() as ollama:
            await draft_issue_suggestion(session, ollama, None, 1)
            sug = await regenerate_section(
                session, ollama, None, 1, "repro_steps", steer="mention Safari"
            )
    by_rid = {s["requirement_id"]: s for s in sug.sections}
    assert by_rid["repro_steps"]["body_md"] == "steered draft"
    assert by_rid["environment"]["origin"] == "scaffold"  # untouched
    # the steer text reached the prompt
    sent = json.loads(respx.calls[-1].request.content)
    assert "mention Safari" in sent["messages"][0]["content"]


async def test_regenerate_unknown_section_raises(clean_db):
    async with get_sessionmaker()() as session:
        await seed(session)
        await service.generate_suggestion(session, 1)
        with pytest.raises(SectionNotFound):
            await regenerate_section(session, None, None, 1, "nope")


async def test_patch_section_remove_and_restore_recomposes(clean_db):
    async with get_sessionmaker()() as session:
        await seed(session)
        await service.generate_suggestion(session, 1)
        sug = await patch_section(session, 1, "environment", removed=True)
        assert "## Environment" not in sug.proposed_body
        sug = await patch_section(session, 1, "environment", removed=False)
        assert "## Environment" in sug.proposed_body


@respx.mock
async def test_repo_sweep_drafts_eligible_and_records_job(clean_db):
    mock_tags()
    respx.post(f"{OLLAMA}/api/chat").mock(
        return_value=chat({
            "repro_steps": {"grounded": True, "body_md": "x"},
            "environment": {"grounded": False, "body_md": ""},
        })
    )
    async with get_sessionmaker()() as session:
        await seed(session)
        async with make_ollama_client() as ollama:
            count = await draft_repository_suggestions(session, ollama, None, 1)
        assert count == 1
        # second sweep: nothing stale, nothing drafted
        async with make_ollama_client() as ollama:
            count = await draft_repository_suggestions(session, ollama, None, 1)
        assert count == 0
        from sqlalchemy import select
        jobs = list(
            (await session.execute(select(SyncJob).where(SyncJob.kind == "draft"))).scalars()
        )
        assert [j.status for j in jobs] == ["success", "success"]
```

NOTE: this test file depends on Task 7's change to `service.generate_suggestion` (it must populate `sections`). Tasks 5 and 7 are written to be committed in the order 5 → 7, so in THIS task, the three tests that call `service.generate_suggestion` (`test_draft_refuses_pushed_suggestion`, `test_regenerate_unknown_section_raises`, `test_patch_section_remove_and_restore_recomposes`) must instead seed the suggestion via `draft_issue_suggestion` where possible, or create the `IssueSuggestion` row directly with ORM using `scaffold_section`:

```python
from app.triage.sections import compose_proposed_body, scaffold_section

async def seed_scaffold_suggestion(session):
    sections = [scaffold_section("repro_steps"), scaffold_section("environment")]
    session.add(IssueSuggestion(
        issue_id=1, status="draft", base_body="...", base_gh_updated_at=NOW,
        proposed_body=compose_proposed_body("...", sections),
        missing_requirements=[
            {"id": "repro_steps", "label": "Reproduction steps"},
            {"id": "environment", "label": "Environment or version"},
        ],
        sections=sections,
    ))
    await session.commit()
```

Use `seed_scaffold_suggestion` in those three tests instead of `service.generate_suggestion`.

- [ ] **Step 2: Run to verify failure**

Run: `cd backend && python -m pytest tests/test_triage_drafting.py -q`
Expected: FAIL — `ModuleNotFoundError: app.triage.drafting`

- [ ] **Step 3: Implement**

```python
import logging

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import get_settings
from app.llm.draft import build_draft_prompt, draft_sections
from app.llm.ollama import ensure_model
from app.llm.readiness import RUBRICS
from app.models import (
    Issue, IssueClassification, IssueReadiness, IssueSuggestion, Repository, SyncJob,
)
from app.triage.context import gather_draft_context
from app.triage.sections import compose_proposed_body, scaffold_section
from app.triage.service import (
    SuggestionConflict, SuggestionNotFound, missing_requirements,
)

logger = logging.getLogger(__name__)

DRAFT_THRESHOLD = 80


class SectionNotFound(Exception):
    pass


def _labels_by_rid(issue_type: str) -> dict[str, str]:
    return {r.id: r.label for r in RUBRICS[issue_type]}


async def _load_issue_bundle(session: AsyncSession, issue_id: int):
    row = (
        await session.execute(
            select(Issue, Repository, IssueClassification, IssueReadiness)
            .join(Repository, Repository.id == Issue.repository_id)
            .join(IssueClassification, IssueClassification.issue_id == Issue.id)
            .join(IssueReadiness, IssueReadiness.issue_id == Issue.id)
            .where(Issue.id == issue_id)
        )
    ).first()
    if row is None:
        raise SuggestionNotFound()
    return row


def _merge_sections(
    existing: list[dict] | None,
    missing: list[dict],
    drafts: dict[str, dict],
    base_changed: bool,
) -> list[dict]:
    """Rebuild the section list from the current missing set.

    Preserves edited/removed entries whose rid is still missing; redrafts the
    rest from `drafts`; drops rids no longer missing.
    """
    existing_by_rid = {s["requirement_id"]: s for s in (existing or [])}
    merged: list[dict] = []
    for item in missing:
        rid = item["id"]
        old = existing_by_rid.get(rid)
        if old is not None and old["edited"]:
            kept = dict(old)
            if base_changed:
                kept["stale"] = True
            merged.append(kept)
            continue
        draft = drafts.get(rid, {"grounded": False, "body_md": ""})
        if draft["grounded"]:
            section = scaffold_section(rid)
            section.update(
                body_md=draft["body_md"], origin="ai", model=get_settings().ollama_model
            )
        else:
            section = scaffold_section(rid)
        if old is not None and old["removed"]:
            section["removed"] = True
        merged.append(section)
    return merged


async def draft_issue_suggestion(
    session: AsyncSession, ollama_client, gh_client, issue_id: int
) -> IssueSuggestion:
    issue, repo, classification, readiness = await _load_issue_bundle(session, issue_id)
    sug = (
        await session.execute(
            select(IssueSuggestion).where(IssueSuggestion.issue_id == issue_id)
        )
    ).scalar_one_or_none()
    if sug is not None and sug.status in ("pushed", "rejected"):
        raise SuggestionConflict(f"suggestion is {sug.status}")

    missing = missing_requirements(readiness.issue_type, readiness.factors)
    labels = _labels_by_rid(readiness.issue_type)
    existing_by_rid = {s["requirement_id"]: s for s in (sug.sections if sug and sug.sections else [])}
    to_draft = [
        m["id"] for m in missing
        if not (existing_by_rid.get(m["id"], {}).get("edited"))
    ]
    drafts: dict[str, dict] = {}
    if to_draft:
        context = await gather_draft_context(session, gh_client, issue, repo)
        prompt = build_draft_prompt(
            issue_type=readiness.issue_type,
            title=issue.title,
            labels=[lb["name"] for lb in issue.labels],
            body=issue.body or "",
            comments=context["comments"],
            repo_card=context["repo_card"],
            references=context["references"],
            requirements=[(rid, labels[rid]) for rid in to_draft],
        )
        drafts = await draft_sections(ollama_client, prompt, to_draft)

    base_changed = sug is not None and (issue.body or "") != sug.base_body
    sections = _merge_sections(
        sug.sections if sug else None, missing, drafts, base_changed
    )
    proposed = compose_proposed_body(issue.body or "", sections)

    if sug is None:
        sug = IssueSuggestion(issue_id=issue_id, status="draft")
        session.add(sug)
    sug.base_body = issue.body or ""
    sug.base_gh_updated_at = issue.gh_updated_at
    sug.sections = sections
    sug.proposed_body = proposed
    sug.missing_requirements = missing
    sug.drafted_at = func.now()
    await session.commit()
    await session.refresh(sug)
    return sug


async def _get_suggestion_or_raise(session: AsyncSession, issue_id: int) -> IssueSuggestion:
    sug = (
        await session.execute(
            select(IssueSuggestion).where(IssueSuggestion.issue_id == issue_id)
        )
    ).scalar_one_or_none()
    if sug is None:
        raise SuggestionNotFound()
    if sug.status == "pushed":
        raise SuggestionConflict("suggestion has already been pushed")
    return sug


def _find_section(sug: IssueSuggestion, requirement_id: str) -> dict:
    for section in sug.sections or []:
        if section["requirement_id"] == requirement_id:
            return section
    raise SectionNotFound()


async def regenerate_section(
    session: AsyncSession,
    ollama_client,
    gh_client,
    issue_id: int,
    requirement_id: str,
    steer: str | None = None,
) -> IssueSuggestion:
    sug = await _get_suggestion_or_raise(session, issue_id)
    _find_section(sug, requirement_id)
    issue, repo, classification, readiness = await _load_issue_bundle(session, issue_id)
    labels = _labels_by_rid(readiness.issue_type)
    if requirement_id not in labels:
        raise SectionNotFound()
    context = await gather_draft_context(session, gh_client, issue, repo)
    prompt = build_draft_prompt(
        issue_type=readiness.issue_type,
        title=issue.title,
        labels=[lb["name"] for lb in issue.labels],
        body=issue.body or "",
        comments=context["comments"],
        repo_card=context["repo_card"],
        references=context["references"],
        requirements=[(requirement_id, labels[requirement_id])],
        steer=steer,
    )
    drafts = await draft_sections(ollama_client, prompt, [requirement_id])
    draft = drafts[requirement_id]

    sections = [dict(s) for s in sug.sections]
    for section in sections:
        if section["requirement_id"] != requirement_id:
            continue
        if draft["grounded"]:
            section.update(
                body_md=draft["body_md"], origin="ai",
                model=get_settings().ollama_model,
            )
        else:
            fresh = scaffold_section(requirement_id)
            section.update(body_md=fresh["body_md"], origin="scaffold", model=None)
        section.update(edited=False, stale=False)
    sug.sections = sections
    sug.proposed_body = compose_proposed_body(sug.base_body, sections)
    sug.drafted_at = func.now()
    await session.commit()
    await session.refresh(sug)
    return sug


async def patch_section(
    session: AsyncSession,
    issue_id: int,
    requirement_id: str,
    body_md: str | None = None,
    removed: bool | None = None,
) -> IssueSuggestion:
    sug = await _get_suggestion_or_raise(session, issue_id)
    _find_section(sug, requirement_id)
    sections = [dict(s) for s in sug.sections]
    for section in sections:
        if section["requirement_id"] != requirement_id:
            continue
        if body_md is not None:
            section.update(body_md=body_md, edited=True, stale=False)
        if removed is not None:
            section["removed"] = removed
    sug.sections = sections
    sug.proposed_body = compose_proposed_body(sug.base_body, sections)
    sug.edited = True if body_md is not None else sug.edited
    await session.commit()
    await session.refresh(sug)
    return sug


def _eligible_issues_query(repo_id: int):
    return (
        select(Issue.id)
        .join(IssueClassification, IssueClassification.issue_id == Issue.id)
        .join(IssueReadiness, IssueReadiness.issue_id == Issue.id)
        .outerjoin(IssueSuggestion, IssueSuggestion.issue_id == Issue.id)
        .where(
            Issue.repository_id == repo_id,
            Issue.is_pull_request.is_(False),
            Issue.state == "open",
            IssueReadiness.score < DRAFT_THRESHOLD,
            IssueSuggestion.issue_id.is_(None)
            | (
                IssueSuggestion.status.notin_(["pushed", "rejected"])
                & (
                    IssueSuggestion.drafted_at.is_(None)
                    | (Issue.gh_updated_at > IssueSuggestion.base_gh_updated_at)
                )
            ),
        )
        .order_by(Issue.id)
    )


async def draft_repository_suggestions(
    session: AsyncSession, ollama_client, gh_client, repo_id: int
) -> int:
    job = SyncJob(repository_id=repo_id, kind="draft", status="running")
    session.add(job)
    await session.commit()
    job_id = job.id
    try:
        await ensure_model(ollama_client)
        issue_ids = list(
            (await session.execute(_eligible_issues_query(repo_id))).scalars()
        )
        drafted = 0
        for issue_id in issue_ids:
            try:
                await draft_issue_suggestion(session, ollama_client, gh_client, issue_id)
            except Exception:
                logger.exception(
                    "section drafting failed for issue %s in repo %s", issue_id, repo_id
                )
                await session.rollback()
                continue
            drafted += 1
        job.status = "success"
        job.issues_upserted = drafted
        job.finished_at = func.now()
        await session.commit()
        return drafted
    except Exception as exc:
        try:
            await session.rollback()
            job = (
                await session.execute(select(SyncJob).where(SyncJob.id == job_id))
            ).scalar_one()
            job.status = "error"
            job.error = str(exc)[:500]
            job.finished_at = func.now()
            await session.commit()
        except Exception:
            logger.exception(
                "failed to record error state for sync job %s (repo %s)", job_id, repo_id
            )
        raise
```

- [ ] **Step 4: Run tests**

Run: `cd backend && python -m pytest tests/test_triage_drafting.py tests/test_triage_sections.py -q`
Expected: all PASS

- [ ] **Step 5: Commit**

```bash
git add backend/app/triage/drafting.py backend/tests/test_triage_drafting.py
git commit -m "feat: drafting service — bulk draft, per-section regenerate/steer/patch, repo sweep"
```

---

### Task 6: Worker + pipeline wiring

**Files:**
- Modify: `backend/worker.py`
- Test: `backend/tests/test_draft_worker.py`

**Interfaces:**
- Consumes: `draft_repository_suggestions` (Task 5).
- Produces: arq task `draft_suggestions_repository(ctx, repo_id)`; `score_priority_repository` now enqueues it; cron sweep `draft_all_repositories` at minutes {5, 35}.

- [ ] **Step 1: Write the failing test**

Open `backend/tests/test_classify_worker.py` FIRST and mirror its mocking approach for arq ctx/redis exactly (it already solves fake-redis enqueue capture). The test asserts:

```python
# Adapt imports/fixtures to match test_classify_worker.py's style exactly.
import worker as worker_module


def test_priority_worker_chains_draft_job(monkeypatch):
    # reuse test_classify_worker.py's FakeRedis/ctx pattern; assert that after
    # score_priority_repository runs, a job named "draft_suggestions_repository"
    # was enqueued with _job_id == "draft-<repo_id>".
    ...


def test_worker_settings_register_draft_functions():
    names = {getattr(f, "__name__", getattr(f, "coroutine", None) and f.coroutine.__name__)
             for f in worker_module.WorkerSettings.functions}
    assert "draft_suggestions_repository" in {n for n in names if n}
    cron_names = {c.name for c in worker_module.WorkerSettings.cron_jobs}
    assert "draft_all_repositories" in cron_names
```

Replace the `...` with the concrete FakeRedis pattern from `test_classify_worker.py` — the plan intentionally defers to that file as the single source of truth for arq test plumbing. Note `score_priority_repository` currently opens a real Ollama client; monkeypatch `worker_module.score_repository_priorities` to an async no-op returning 0 (again mirroring how `test_classify_worker.py` stubs its pipeline function).

- [ ] **Step 2: Run to verify failure**

Run: `cd backend && python -m pytest tests/test_draft_worker.py -q`
Expected: FAIL (no `draft_suggestions_repository`)

- [ ] **Step 3: Implement in `worker.py`**

Add import at top with the others:

```python
from app.triage.drafting import draft_repository_suggestions
```

Change `score_priority_repository` to chain the draft job:

```python
async def score_priority_repository(ctx: dict, repo_id: int) -> int:
    async with get_sessionmaker()() as session, make_ollama_client() as client:
        count = await score_repository_priorities(session, client, repo_id)
    redis = ctx.get("redis")
    if redis is not None:
        await redis.enqueue_job(
            "draft_suggestions_repository", repo_id, _job_id=f"draft-{repo_id}"
        )
    return count
```

Add the task and the sweep (place after `score_priority_repository`):

```python
async def draft_suggestions_repository(ctx: dict, repo_id: int) -> int:
    async with (
        get_sessionmaker()() as session,
        make_ollama_client() as ollama,
        make_http_client() as gh,
    ):
        return await draft_repository_suggestions(session, ollama, gh, repo_id)


async def draft_all_repositories(ctx: dict) -> int:
    """Safety net for issues scored while the worker was down; dedupe-keyed."""
    from sqlalchemy import select

    from app.models import Repository

    async with get_sessionmaker()() as session:
        repo_ids = list((await session.execute(select(Repository.id))).scalars())
    done = 0
    for repo_id in repo_ids:
        try:
            await ctx["redis"].enqueue_job(
                "draft_suggestions_repository", repo_id, _job_id=f"draft-{repo_id}"
            )
            done += 1
        except Exception:
            logger.exception("draft sweep failed for repo %s", repo_id)
    return done
```

Register both in `WorkerSettings`:

```python
    functions = [
        func(ping, keep_result=60),
        sync_repository,
        classify_repository,
        score_readiness_repository,
        score_priority_repository,
        draft_suggestions_repository,
    ]
    cron_jobs = [
        cron(reconcile_all_repositories, name="reconcile_all_repositories", minute={0, 30}),
        cron(classify_all_repositories, name="classify_all_repositories", minute={15, 45}),
        cron(score_all_repositories, name="score_all_repositories", minute={20, 50}),
        cron(priority_all_repositories, name="priority_all_repositories", minute={25, 55}),
        cron(draft_all_repositories, name="draft_all_repositories", minute={5, 35}),
        cron(expire_stuck_sync_jobs, name="expire_stuck_sync_jobs", minute={10, 40}),
    ]
```

- [ ] **Step 4: Run tests**

Run: `cd backend && python -m pytest tests/test_draft_worker.py tests/test_classify_worker.py -q`
Expected: all PASS

- [ ] **Step 5: Commit**

```bash
git add backend/worker.py backend/tests/test_draft_worker.py
git commit -m "feat: draft job in sync pipeline + cron sweep"
```

---

### Task 7: Service + router API changes (sections in, diff out)

**Files:**
- Modify: `backend/app/triage/service.py` (`generate_suggestion`)
- Modify: `backend/app/routers/triage.py`
- Delete: `backend/app/triage/diff.py`, `backend/tests/test_diff.py`
- Test: `backend/tests/test_api_triage.py` (update in place)

**Interfaces:**
- Consumes: `scaffold_section`, `compose_proposed_body` (Task 2); `regenerate_section`, `patch_section`, `SectionNotFound` (Task 5).
- Produces (API contract the frontend consumes):
  - `SuggestionOut`: `issue_id, status, base_body, proposed_body, missing_requirements, edited, sections: list[SectionOut], drafted_at: datetime | None, pushed_at` — **no `diff` field**.
  - `SectionOut`: `requirement_id: str, heading: str, body_md: str, origin: Literal["ai","scaffold"], model: str | None, edited: bool, removed: bool, stale: bool`.
  - `POST /issues/{issue_id}/suggestion/sections/{requirement_id}/regenerate` body `{"steer": str | null}` → `SuggestionOut` (404 unknown section/suggestion, 409 pushed).
  - `PATCH /issues/{issue_id}/suggestion/sections/{requirement_id}` body `{"body_md": str | null, "removed": bool | null}` → `SuggestionOut`.

- [ ] **Step 1: Update `generate_suggestion` in `service.py`**

Replace the body construction in `generate_suggestion` (currently `build_proposed_body(...)` + `values = {...}`) with section-based construction and a draft-job enqueue. Replace this block:

```python
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
```

with:

```python
    missing = missing_requirements(readiness.issue_type, readiness.factors)
    sections = [scaffold_section(m["id"]) for m in missing]
    proposed = compose_proposed_body(issue.body or "", sections)
    values = {
        "issue_id": issue_id,
        "status": "draft",
        "base_body": issue.body or "",
        "base_gh_updated_at": issue.gh_updated_at,
        "proposed_body": proposed,
        "missing_requirements": missing,
        "sections": sections,
        "drafted_at": None,
        "edited": False,
        "updated_at": func.now(),
        "pushed_at": None,
    }
```

Update the imports: remove `from app.triage.scaffold import build_proposed_body`, add `from app.triage.sections import compose_proposed_body, scaffold_section`. After the upsert + commit (before `return sug`), enqueue the draft job following the existing `_enqueue_rescore` pattern:

```python
    try:
        pool = await get_arq_pool()
        await pool.enqueue_job(
            "draft_suggestions_repository",
            issue.repository_id,
            _job_id=f"draft-{issue.repository_id}",
        )
    except Exception:
        logger.warning(
            "failed to enqueue drafting for repo %s after suggestion generate",
            issue.repository_id,
            exc_info=True,
        )
```

(`issue` is in scope; `get_arq_pool` is already imported.)

- [ ] **Step 2: Rewrite router models/endpoints in `routers/triage.py`**

Remove `from app.triage.diff import build_diff`. Add imports:

```python
from app.llm.ollama import make_ollama_client
from app.triage import drafting
```

Replace `SuggestionOut` and `_to_out`; add section models/endpoints:

```python
class SectionOut(BaseModel):
    requirement_id: str
    heading: str
    body_md: str
    origin: Literal["ai", "scaffold"]
    model: str | None
    edited: bool
    removed: bool
    stale: bool


class SuggestionOut(BaseModel):
    issue_id: int
    status: str
    base_body: str
    proposed_body: str
    missing_requirements: list[MissingItem]
    edited: bool
    sections: list[SectionOut]
    drafted_at: datetime | None
    pushed_at: datetime | None


def _to_out(sug: IssueSuggestion) -> SuggestionOut:
    return SuggestionOut(
        issue_id=sug.issue_id,
        status=sug.status,
        base_body=sug.base_body,
        proposed_body=sug.proposed_body,
        missing_requirements=sug.missing_requirements,
        edited=sug.edited,
        sections=sug.sections or [],
        drafted_at=sug.drafted_at,
        pushed_at=sug.pushed_at,
    )


class SectionPatch(BaseModel):
    body_md: str | None = None
    removed: bool | None = None


class SteerBody(BaseModel):
    steer: str | None = None


@router.post(
    "/issues/{issue_id}/suggestion/sections/{requirement_id}/regenerate",
    response_model=SuggestionOut,
)
async def regenerate_section(
    issue_id: int,
    requirement_id: str,
    body: SteerBody,
    session: AsyncSession = Depends(get_session),
) -> SuggestionOut:
    try:
        async with make_ollama_client() as ollama:
            sug = await drafting.regenerate_section(
                session, ollama, None, issue_id, requirement_id, steer=body.steer
            )
    except service.SuggestionNotFound:
        raise HTTPException(status_code=404, detail="No suggestion for this issue")
    except drafting.SectionNotFound:
        raise HTTPException(status_code=404, detail="No such section")
    except service.SuggestionConflict as exc:
        raise HTTPException(status_code=409, detail=str(exc))
    return _to_out(sug)


@router.patch(
    "/issues/{issue_id}/suggestion/sections/{requirement_id}",
    response_model=SuggestionOut,
)
async def patch_section(
    issue_id: int,
    requirement_id: str,
    patch: SectionPatch,
    session: AsyncSession = Depends(get_session),
) -> SuggestionOut:
    try:
        sug = await drafting.patch_section(
            session, issue_id, requirement_id,
            body_md=patch.body_md, removed=patch.removed,
        )
    except service.SuggestionNotFound:
        raise HTTPException(status_code=404, detail="No suggestion for this issue")
    except drafting.SectionNotFound:
        raise HTTPException(status_code=404, detail="No such section")
    except service.SuggestionConflict as exc:
        raise HTTPException(status_code=409, detail=str(exc))
    return _to_out(sug)
```

The regenerate endpoint passes `gh_client=None` deliberately: the synchronous request path drafts from mirror context only (fast, no GitHub round-trips); the background sweep is where live comments get fetched. This is an intentional simplification — record it in the commit message.

- [ ] **Step 3: Delete diff module and grep for ALL remaining call sites**

```bash
rm backend/app/triage/diff.py backend/tests/test_diff.py
grep -rn "build_diff\|from app.triage.diff\|\"diff\"\|suggestion-diff" backend/ frontend/src/ frontend/e2e/
```

Fix every hit the grep finds (backend AND frontend/e2e — frontend hits get fixed in Task 8, but list them in your task report). Do not assume this plan's list is complete.

- [ ] **Step 4: Update `tests/test_api_triage.py`**

Update assertions that reference `diff`. In `test_generate_then_get_produces_scaffold_and_diff` (rename to `test_generate_then_get_produces_scaffold_sections`), replace:

```python
    assert any(o["op"] == "add" for o in data["diff"])
```

with:

```python
    assert data["drafted_at"] is None
    rids = [s["requirement_id"] for s in data["sections"]]
    assert "repro_steps" in rids
    assert all(s["origin"] == "scaffold" for s in data["sections"])
```

Add two endpoint tests at the end of the file:

```python
async def test_patch_section_edit_and_remove(clean_db, api):
    await seed_issues()
    await seed_classifications()
    await seed_readiness()
    await api.post("/issues/1/suggestion")
    resp = await api.patch(
        "/issues/1/suggestion/sections/repro_steps", json={"body_md": "1. my steps"}
    )
    assert resp.status_code == 200
    data = resp.json()
    section = next(s for s in data["sections"] if s["requirement_id"] == "repro_steps")
    assert section["edited"] is True
    assert "1. my steps" in data["proposed_body"]
    resp = await api.patch(
        "/issues/1/suggestion/sections/repro_steps", json={"removed": True}
    )
    assert "1. my steps" not in resp.json()["proposed_body"]


async def test_patch_unknown_section_404(clean_db, api):
    await seed_issues()
    await seed_classifications()
    await seed_readiness()
    await api.post("/issues/1/suggestion")
    resp = await api.patch("/issues/1/suggestion/sections/nope", json={"removed": True})
    assert resp.status_code == 404
```

(The generate flow seeds sections now, so these run without Ollama. A regenerate-endpoint test would need a mocked Ollama — the service layer already covers it in Task 5; skip it here.)

- [ ] **Step 5: Run the full backend suite + lint**

Run: `cd backend && ruff check . && python -m pytest tests/ -q`
Expected: all PASS, no lint errors. Fix any straggler `diff` references the suite surfaces.

- [ ] **Step 6: Commit**

```bash
git add -A backend/
git commit -m "feat: sections API — scaffold-first generate, section patch/regenerate endpoints, retire line diff"
```

---

### Task 8: Drawer rewrite — side-by-side panes (view layer)

**Files:**
- Rewrite: `frontend/src/app/triage/suggestion-drawer.tsx`
- Modify: `frontend/e2e/triage.spec.ts` (update selectors; open the file first and adapt every `suggestion-diff` reference)

**Interfaces:**
- Consumes: the Task 7 API (`SuggestionOut` with `sections`, `drafted_at`; no `diff`).
- Produces test ids the e2e relies on: `suggestion-drawer`, `suggestion-panes`, `original-pane`, `proposed-pane`, `gap-marker-<rid>`, `section-block-<rid>`, `section-chip-<rid>`, `suggestion-footnote`, `approve-push`, `push-error`, `drafting-indicator`.
- Produces (for Task 9): `Suggestion` and `Section` TS types exported from the drawer module.

**Layout contract (spec D1):** one CSS grid, two columns above 720px (`grid-cols-1 min-[720px]:grid-cols-2`), row-aligned: row 1 = original body (dimmed markdown) | proposed base (dimmed); one row per non-removed section = gap marker | section block. Below 720px, the original column is hidden (`hidden min-[720px]:block`) — that IS the variant-A fallback.

- [ ] **Step 1: Rewrite the component**

```tsx
"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { getJson, sendJson } from "../../lib/api";

export type Section = {
  requirement_id: string;
  heading: string;
  body_md: string;
  origin: "ai" | "scaffold";
  model: string | null;
  edited: boolean;
  removed: boolean;
  stale: boolean;
};

export type Suggestion = {
  issue_id: number;
  status: string;
  base_body: string;
  proposed_body: string;
  missing_requirements: { id: string; label: string }[];
  edited: boolean;
  sections: Section[];
  drafted_at: string | null;
  pushed_at: string | null;
};

const base = "/api/backend/issues";
export const btn =
  "rounded-lg border border-(--color-border) bg-(--color-surface) px-2.5 py-1.5 transition-all duration-150 hover:bg-(--accent-tint) disabled:text-(--color-text-muted)";

function Markdown({ children }: { children: string }) {
  return (
    <div className="prose-sm max-w-none text-[13px] leading-relaxed [&_h2]:mt-3 [&_h2]:text-[13px] [&_h2]:font-semibold">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{children}</ReactMarkdown>
    </div>
  );
}

function SectionChip({ section }: { section: Section }) {
  if (section.origin === "ai") {
    return (
      <span
        className="rounded-full bg-(--accent-tint) px-2 py-0.5 text-[10px] font-semibold tracking-wide text-(--color-primary)"
        data-testid={`section-chip-${section.requirement_id}`}
      >
        AI DRAFT{section.model ? ` · ${section.model}` : ""}
      </span>
    );
  }
  return (
    <span
      className="rounded-full border border-(--color-border) px-2 py-0.5 text-[10px] font-semibold tracking-wide text-(--color-text-muted)"
      data-testid={`section-chip-${section.requirement_id}`}
    >
      EMPTY SCAFFOLD
    </span>
  );
}

export function footnotePreview(sections: Section[]): string | null {
  const ai = sections.filter((s) => !s.removed && s.origin === "ai");
  if (ai.length === 0) return null;
  const names = ai.map((s) => `"${s.heading}"`);
  const joined =
    names.length === 1
      ? names[0]
      : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
  const models = [...new Set(ai.map((s) => s.model).filter(Boolean))].join(", ");
  return `Sections ${joined} drafted by ${models} from the existing report — please confirm or correct.`;
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
  const applyResult = (data: Suggestion) => {
    qc.setQueryData(["suggestion", issueId], data);
    qc.invalidateQueries({ queryKey: ["triage-inbox"] });
  };

  const { data, error, isPending } = useQuery({
    queryKey: ["suggestion", issueId],
    queryFn: () =>
      hasExisting
        ? getJson<Suggestion>(`${base}/${issueId}/suggestion`)
        : sendJson<Suggestion>(`${base}/${issueId}/suggestion`, "POST"),
    staleTime: Infinity,
    // Poll while background drafting has not landed yet.
    refetchInterval: (query) =>
      query.state.data && query.state.data.drafted_at === null ? 3000 : false,
  });

  const setStatus = useMutation({
    mutationFn: (status: "suggested" | "rejected") =>
      sendJson<Suggestion>(`${base}/${issueId}/suggestion`, "PATCH", { status }),
    onSuccess: (data, status) => {
      applyResult(data);
      if (status === "rejected") onClose();
    },
  });
  const regenerateAll = useMutation({
    mutationFn: () => sendJson<Suggestion>(`${base}/${issueId}/suggestion`, "POST"),
    onSuccess: applyResult,
  });
  const push = useMutation({
    mutationFn: () =>
      sendJson<Suggestion>(`${base}/${issueId}/suggestion/push`, "POST"),
    onSuccess: applyResult,
  });

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
  const visibleSections = data.sections.filter((s) => !s.removed);
  const removedSections = data.sections.filter((s) => s.removed);
  const note = footnotePreview(data.sections);

  return (
    <div className="flex flex-col gap-3" data-testid="suggestion-drawer">
      <div className="flex items-center gap-2 text-sm font-semibold">
        Proposed changes · {data.status}
        {data.edited ? " (edited)" : ""}
        {data.drafted_at === null && !locked ? (
          <span
            className="text-[11px] font-normal text-(--color-primary)"
            data-testid="drafting-indicator"
          >
            drafting answers…
          </span>
        ) : null}
      </div>

      <div
        className="grid grid-cols-1 gap-x-3 gap-y-2 min-[720px]:grid-cols-2"
        data-testid="suggestion-panes"
      >
        <div
          className="hidden rounded-lg border border-(--color-border) bg-(--color-surface) p-3 opacity-60 min-[720px]:block"
          data-testid="original-pane"
        >
          <div className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-(--color-text-muted)">
            Original
          </div>
          <Markdown>{data.base_body || "*(empty body)*"}</Markdown>
          {visibleSections.map((s) => (
            <div
              key={s.requirement_id}
              className="mt-2 rounded-md border border-dashed border-(--color-border) px-3 py-1.5 text-center text-[11px] text-(--color-text-muted)"
              data-testid={`gap-marker-${s.requirement_id}`}
            >
              no “{s.heading}” section
            </div>
          ))}
        </div>

        <div
          className="rounded-lg border border-(--color-border) bg-(--color-surface) p-3"
          data-testid="proposed-pane"
        >
          <div className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-(--color-text-muted)">
            Proposed
          </div>
          <div className="opacity-60">
            <Markdown>{data.base_body || "*(empty body)*"}</Markdown>
          </div>
          {visibleSections.map((s) => (
            <SectionBlock
              key={s.requirement_id}
              issueId={issueId}
              section={s}
              locked={locked}
              applyResult={applyResult}
            />
          ))}
          {note ? (
            <div
              className="mt-3 border-t border-(--color-border) pt-2 text-[11px] italic text-(--color-text-muted)"
              data-testid="suggestion-footnote"
            >
              {note}
            </div>
          ) : null}
        </div>
      </div>

      {removedSections.length > 0 && !locked ? (
        <div className="flex flex-wrap items-center gap-2 text-[11px] text-(--color-text-muted)">
          Removed:
          {removedSections.map((s) => (
            <RestoreChip
              key={s.requirement_id}
              issueId={issueId}
              section={s}
              applyResult={applyResult}
            />
          ))}
        </div>
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
          disabled={regenerateAll.isPending}
          onClick={() => {
            if (locked && !window.confirm("Start a new suggestion? This replaces the pushed record.")) {
              return;
            }
            regenerateAll.mutate();
          }}
        >
          Regenerate all
        </button>
      </div>
    </div>
  );
}
```

`SectionBlock` and `RestoreChip` are Task 9 — for THIS task, add minimal versions at the bottom of the same file so it compiles and renders read-only:

```tsx
function SectionBlock({
  section,
}: {
  issueId: number;
  section: Section;
  locked: boolean;
  applyResult: (data: Suggestion) => void;
}) {
  return (
    <div
      className="mt-2 rounded-r-lg border-l-[3px] border-(--type-feature) bg-(--type-feature)/10 px-3 py-2"
      data-testid={`section-block-${section.requirement_id}`}
    >
      <div className="flex items-center gap-2">
        <span className="text-[13px] font-semibold">{section.heading}</span>
        <SectionChip section={section} />
        {section.stale ? (
          <span className="text-[10px] text-(--color-text-muted)">base changed</span>
        ) : null}
      </div>
      <Markdown>{section.body_md}</Markdown>
    </div>
  );
}

function RestoreChip({
  section,
}: {
  issueId: number;
  section: Section;
  applyResult: (data: Suggestion) => void;
}) {
  return <span className="rounded-full border border-(--color-border) px-2 py-0.5">{section.heading}</span>;
}
```

If `bg-(--type-feature)/10` does not produce a wash in this Tailwind version, use an inline style `style={{ background: "color-mix(in srgb, var(--type-feature) 12%, transparent)" }}` instead — verify visually in Step 3.

- [ ] **Step 2: Update `frontend/e2e/triage.spec.ts`**

Open the file; wherever it asserts on `suggestion-diff`, replace with the new contract, e.g.:

```ts
await expect(page.getByTestId("suggestion-panes")).toBeVisible();
await expect(page.getByTestId("section-block-repro_steps")).toBeVisible();
await expect(page.getByTestId("gap-marker-repro_steps")).toBeVisible();
await expect(page.getByTestId("section-chip-repro_steps")).toHaveText(/EMPTY SCAFFOLD|AI DRAFT/);
```

Keep every existing scenario (generate, edit→now section-level, reject, push) — adapt selectors, do not delete coverage. The whole-body textarea is gone; the old "Save edits" flow test should now target Task 9's per-section edit (mark it `test.fixme()` in this task with a `// enabled in next task` note, then enable it in Task 9).

- [ ] **Step 3: Verify**

Run: `cd frontend && npm run lint && npx playwright test e2e/triage.spec.ts`
Expected: lint clean; e2e passes against the dev stack (`docker compose up -d` + seeded data — follow the repo's existing e2e setup in `frontend/e2e/global-setup.ts`). Also eyeball the drawer at 1280px and at 640px (original pane hidden).

- [ ] **Step 4: Commit**

```bash
git add frontend/src/app/triage/suggestion-drawer.tsx frontend/e2e/triage.spec.ts
git commit -m "feat: side-by-side suggestion drawer with section blocks and gap markers"
```

---

### Task 9: Section actions — edit, remove/restore, regenerate + steer popover

**Files:**
- Modify: `frontend/src/app/triage/suggestion-drawer.tsx` (replace the minimal `SectionBlock`/`RestoreChip`)
- Create: `frontend/e2e/triage-sections.spec.ts`

**Interfaces:**
- Consumes: Task 7 endpoints (`PATCH .../sections/{rid}`, `POST .../sections/{rid}/regenerate`).

- [ ] **Step 1: Replace `SectionBlock` and `RestoreChip` with the full implementations**

```tsx
function SectionBlock({
  issueId,
  section,
  locked,
  applyResult,
}: {
  issueId: number;
  section: Section;
  locked: boolean;
  applyResult: (data: Suggestion) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(section.body_md);
  const [steering, setSteering] = useState(false);
  const [steer, setSteer] = useState("");
  const [flash, setFlash] = useState(false);

  const patch = useMutation({
    mutationFn: (body: { body_md?: string; removed?: boolean }) =>
      sendJson<Suggestion>(
        `${base}/${issueId}/suggestion/sections/${section.requirement_id}`,
        "PATCH",
        body,
      ),
    onSuccess: (data) => {
      setEditing(false);
      applyResult(data);
    },
  });
  const regenerate = useMutation({
    mutationFn: (steerText: string | null) =>
      sendJson<Suggestion>(
        `${base}/${issueId}/suggestion/sections/${section.requirement_id}/regenerate`,
        "POST",
        { steer: steerText },
      ),
    onSuccess: (data) => {
      setSteering(false);
      setSteer("");
      setFlash(true);
      setTimeout(() => setFlash(false), 1200);
      applyResult(data);
    },
  });

  const act =
    "text-[11px] text-(--color-text-muted) transition-all duration-150 hover:text-(--color-primary)";

  return (
    <div
      className={`group mt-2 rounded-r-lg border-l-[3px] border-(--type-feature) px-3 py-2 transition-all duration-150 ${
        flash ? "bg-(--flash)" : ""
      }`}
      style={
        flash
          ? undefined
          : { background: "color-mix(in srgb, var(--type-feature) 10%, transparent)" }
      }
      data-testid={`section-block-${section.requirement_id}`}
    >
      <div className="flex items-center gap-2">
        <span className="text-[13px] font-semibold">{section.heading}</span>
        <SectionChip section={section} />
        {section.edited ? (
          <span className="text-[10px] text-(--color-text-muted)">edited</span>
        ) : null}
        {section.stale ? (
          <span className="text-[10px] text-(--color-text-muted)" data-testid={`stale-${section.requirement_id}`}>
            base changed
          </span>
        ) : null}
        {regenerate.isPending ? (
          <span className="text-[10px] text-(--color-primary)" data-testid={`section-spinner-${section.requirement_id}`}>
            redrafting…
          </span>
        ) : null}
      </div>

      {editing ? (
        <div className="mt-1 flex flex-col gap-2">
          <textarea
            aria-label={`Edit ${section.heading}`}
            className="min-h-24 rounded-lg border border-(--color-border) bg-(--color-surface) p-2 font-mono text-[12px]"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            data-testid={`section-editor-${section.requirement_id}`}
          />
          <div className="flex gap-2">
            <button type="button" className={btn} onClick={() => patch.mutate({ body_md: draft })}>
              Save section
            </button>
            <button type="button" className={btn} onClick={() => setEditing(false)}>
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <Markdown>{section.body_md}</Markdown>
      )}

      {!locked && !editing ? (
        <div className="mt-1 flex gap-3 opacity-0 transition-all duration-150 group-focus-within:opacity-100 group-hover:opacity-100">
          <button
            type="button"
            className={act}
            onClick={() => regenerate.mutate(null)}
            data-testid={`regen-${section.requirement_id}`}
          >
            ↻ {section.origin === "ai" ? "Regenerate" : "Try a draft"}
          </button>
          <button
            type="button"
            className={act}
            onClick={() => setSteering((v) => !v)}
            data-testid={`steer-${section.requirement_id}`}
          >
            ✎ Steer…
          </button>
          <button
            type="button"
            className={act}
            onClick={() => {
              setDraft(section.body_md);
              setEditing(true);
            }}
            data-testid={`edit-${section.requirement_id}`}
          >
            Edit
          </button>
          <button
            type="button"
            className={`${act} hover:text-(--type-bug)`}
            onClick={() => patch.mutate({ removed: true })}
            data-testid={`remove-${section.requirement_id}`}
          >
            ✕ Remove
          </button>
        </div>
      ) : null}

      {steering ? (
        <div
          className="mt-2 flex flex-col gap-2 rounded-lg border border-(--color-border) bg-(--color-surface) p-2 shadow-md"
          data-testid={`steer-popover-${section.requirement_id}`}
        >
          <div className="text-[10px] font-semibold uppercase tracking-wider text-(--color-text-muted)">
            Steer this draft
          </div>
          <textarea
            aria-label={`Steer ${section.heading}`}
            className="min-h-16 rounded-lg border border-(--color-border) bg-(--color-bg) p-2 text-[12px]"
            placeholder="Add guidance for the redraft — extra details, corrections, emphasis…"
            value={steer}
            onChange={(e) => setSteer(e.target.value)}
          />
          <div className="flex gap-2">
            <button
              type="button"
              className={`${btn} text-(--color-primary)`}
              disabled={regenerate.isPending}
              onClick={() => regenerate.mutate(steer || null)}
              data-testid={`steer-submit-${section.requirement_id}`}
            >
              Redraft section
            </button>
            <button type="button" className={btn} onClick={() => setSteering(false)}>
              Cancel
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function RestoreChip({
  issueId,
  section,
  applyResult,
}: {
  issueId: number;
  section: Section;
  applyResult: (data: Suggestion) => void;
}) {
  const restore = useMutation({
    mutationFn: () =>
      sendJson<Suggestion>(
        `${base}/${issueId}/suggestion/sections/${section.requirement_id}`,
        "PATCH",
        { removed: false },
      ),
    onSuccess: applyResult,
  });
  return (
    <button
      type="button"
      className="rounded-full border border-(--color-border) px-2 py-0.5 transition-all duration-150 hover:bg-(--accent-tint)"
      onClick={() => restore.mutate()}
      data-testid={`restore-${section.requirement_id}`}
    >
      {section.heading} ↩
    </button>
  );
}
```

If the theme lacks a `--flash` token in `frontend/src/app/globals.css`, add it to both mode blocks (light `#eeeefc`, dark `#2c2c46`) — grep globals.css first.

- [ ] **Step 2: Write `frontend/e2e/triage-sections.spec.ts`**

Regenerate/steer needs Ollama, so mock the API route at the browser layer. Follow the structure of an existing spec (e.g. `triage.spec.ts`) for setup/navigation; core scenarios:

```ts
import { expect, test } from "@playwright/test";

// Navigate to triage, open the first row's suggestion drawer (same helper flow
// as triage.spec.ts — copy its row-open steps).

test("edit a section inline and save", async ({ page }) => {
  // ...open drawer...
  await page.getByTestId("section-block-repro_steps").hover();
  await page.getByTestId("edit-repro_steps").click();
  await page.getByTestId("section-editor-repro_steps").fill("1. my own steps");
  await page.getByRole("button", { name: "Save section" }).click();
  await expect(page.getByTestId("section-block-repro_steps")).toContainText("my own steps");
  await expect(page.getByTestId("section-block-repro_steps")).toContainText("edited");
});

test("remove then restore a section", async ({ page }) => {
  // ...open drawer...
  await page.getByTestId("section-block-environment").hover();
  await page.getByTestId("remove-environment").click();
  await expect(page.getByTestId("section-block-environment")).toHaveCount(0);
  await page.getByTestId("restore-environment").click();
  await expect(page.getByTestId("section-block-environment")).toBeVisible();
});

test("steer popover redrafts via mocked endpoint", async ({ page }) => {
  await page.route("**/suggestion/sections/repro_steps/regenerate", async (route) => {
    const current = await (
      await page.request.get(
        route.request().url().replace(/\/sections\/.*$/, ""),
      )
    ).json();
    const sections = current.sections.map((s: { requirement_id: string }) =>
      s.requirement_id === "repro_steps"
        ? { ...s, body_md: "1. steered draft", origin: "ai", model: "mock", edited: false, stale: false }
        : s,
    );
    await route.fulfill({ json: { ...current, sections, drafted_at: "2026-07-24T00:00:00Z" } });
  });
  // ...open drawer...
  await page.getByTestId("section-block-repro_steps").hover();
  await page.getByTestId("steer-repro_steps").click();
  await page.getByLabel("Steer Reproduction Steps").fill("mention Safari");
  await page.getByTestId("steer-submit-repro_steps").click();
  await expect(page.getByTestId("section-block-repro_steps")).toContainText("steered draft");
  await expect(page.getByTestId("section-chip-repro_steps")).toContainText("AI DRAFT");
  await expect(page.getByTestId("suggestion-footnote")).toContainText("drafted by mock");
});
```

Also re-enable the `test.fixme()` left in Task 8.

- [ ] **Step 3: Verify**

Run: `cd frontend && npm run lint && npx playwright test e2e/triage.spec.ts e2e/triage-sections.spec.ts`
Expected: all pass.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/app/triage/suggestion-drawer.tsx frontend/e2e/triage-sections.spec.ts frontend/e2e/triage.spec.ts frontend/src/app/globals.css
git commit -m "feat: per-section edit/remove/restore, regenerate + steer popover"
```

---

### Task 10: Whole-branch verification

**Files:** none new.

- [ ] **Step 1: Full suites + lint**

Run:
```bash
cd backend && ruff check . && python -m pytest tests/ -q
cd ../frontend && npm run lint && npx playwright test
```
Expected: everything green. Fix anything that fails before proceeding.

- [ ] **Step 2: Live verification (Playwright CLI against the dev stack)**

With the dev stack up and a repo synced: open `/triage`, expand a low-readiness issue, confirm (a) drawer opens instantly with scaffold or drafted sections, (b) drafting-indicator appears then resolves if the worker is running, (c) side-by-side at desktop width / stacked at 640px, (d) footnote lists AI sections, (e) push flow unchanged. Capture a screenshot for the PR.

- [ ] **Step 3: Verify no orphaned dev-server/node processes** (per CLAUDE.md: `netstat -ano | findstr :3005`).

- [ ] **Step 4: Do NOT open a PR — report done and ask the user** (per CLAUDE.md PR flow).
