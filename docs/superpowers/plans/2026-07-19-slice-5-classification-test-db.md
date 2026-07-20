# Slice 5 — Local-LLM Issue Classification + Dedicated Test Database — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Classify every synced non-PR issue into type + component with a local Ollama LLM, surface the results as table columns/filters, and move pytest onto a dedicated `issuelens_test` database.

**Architecture:** A stale-driven arq job (`classify_repository`) runs after each sync (plus a cron safety net), calls Ollama's JSON-schema-constrained chat API via plain `httpx`, and upserts into a new `issue_classifications` table (1:1 with issues, staleness tracked via a `gh_updated_at` snapshot). The issues API LEFT JOINs the table; the frontend adds Type/Component columns and toolbar filters. Tests run against `issuelens_test`, created + migrated by a session-scoped fixture.

**Tech Stack:** FastAPI + SQLAlchemy 2 async + Alembic + arq (existing), Ollama (`ollama/ollama` docker image, model `qwen3:8b`), httpx + respx (existing), Next.js + Tailwind v4 + TanStack Query + Playwright (existing).

**Spec:** `docs/superpowers/specs/2026-07-19-slice-5-classification-test-db-design.md`

## Global Constraints

- **No new Python or npm dependencies.** Ollama is called with `httpx` (already a dependency); tests mock it with `respx` (already a dev dependency).
- **Working directory for backend commands:** `backend/` (`uv run pytest`, `uv run ruff check .`). Frontend commands run in `frontend/`.
- **Prerequisites for backend tests:** `docker compose up -d postgres redis worker` (same as today).
- **Tailwind v4 CSS-variable syntax:** `text-(--color-X)` / `border-(--color-X)` parentheses form. NEVER `text-[--color-X]` bracket form (generates empty CSS).
- **No hardcoded colors in components** — all color through CSS custom properties defined in `frontend/src/app/globals.css` (both `:root` light block and `[data-mode="dark"]` block).
- **Tailwind class strings must be static literals** (no template-interpolated class names) so the compiler can extract them — use lookup maps keyed by value.
- **Never hide UI elements when data is missing** — render a muted `—` placeholder instead (same element, muted color).
- **Commit messages:** no AI-attribution/Co-Authored-By lines. Conventional-commit style (`feat:`, `fix:`, `test:`, `chore:`).
- **Type taxonomy (exact strings, used across backend, API, and frontend):** `bug`, `feature`, `debt`, `question`, `docs`.
- **arq:** `WorkerSettings.keep_result = 0` already set — deterministic `_job_id` re-enqueue is safe; do not change it.
- **Grep for ALL call sites** when changing a signature or fixture — do not assume the ones listed here are exhaustive.

---

### Task 1: Dedicated test database (#19)

**Files:**
- Modify: `backend/tests/conftest.py`

**Interfaces:**
- Produces: module constants `TEST_DB_NAME = "issuelens_test"`, `TEST_DATABASE_URL` (asyncpg URL to the test DB); session-scoped autouse fixture `test_database`; `pin_env` now pins `ISSUELENS_DATABASE_URL` to `TEST_DATABASE_URL`. Later tasks rely on tests running against `issuelens_test` with migrations at head.

- [ ] **Step 1: Capture the dev-DB row count (this is the regression check)**

Run:
```sh
docker compose exec postgres psql -U issuelens -d issuelens -t -c "SELECT count(*) FROM issues"
```
Note the number (call it `N_DEV`). If the dev DB is empty that's fine — note `0`.

- [ ] **Step 2: Rewrite `backend/tests/conftest.py`**

Replace the entire file with:

```python
import asyncio
import os
import subprocess
import sys
from pathlib import Path

import asyncpg
import pytest
from sqlalchemy import text

from app.config import get_settings
from app.db import get_engine, get_sessionmaker

TEST_DB_NAME = "issuelens_test"
TEST_DATABASE_URL = (
    f"postgresql+asyncpg://issuelens:issuelens@localhost:5432/{TEST_DB_NAME}"
)
MAINTENANCE_DSN = "postgresql://issuelens:issuelens@localhost:5432/issuelens"
BACKEND_DIR = Path(__file__).resolve().parent.parent


async def _create_test_db() -> None:
    conn = await asyncpg.connect(MAINTENANCE_DSN)
    try:
        await conn.execute(f'CREATE DATABASE "{TEST_DB_NAME}"')
    except asyncpg.DuplicateDatabaseError:
        pass
    finally:
        await conn.close()


@pytest.fixture(scope="session", autouse=True)
def test_database():
    """Create issuelens_test and migrate it to head. Dev data is never touched."""
    asyncio.run(_create_test_db())
    subprocess.run(
        [sys.executable, "-m", "alembic", "upgrade", "head"],
        check=True,
        cwd=BACKEND_DIR,
        env={**os.environ, "ISSUELENS_DATABASE_URL": TEST_DATABASE_URL},
    )


@pytest.fixture(autouse=True)
async def pin_env(monkeypatch):
    """Pin behavior-affecting env vars explicitly; never inherit host state silently."""
    monkeypatch.setenv("ISSUELENS_DATABASE_URL", TEST_DATABASE_URL)
    monkeypatch.setenv("ISSUELENS_REDIS_URL", "redis://127.0.0.1:6379/0")
    monkeypatch.delenv("ISSUELENS_GITHUB_APP_ID", raising=False)
    monkeypatch.delenv("ISSUELENS_GITHUB_APP_PRIVATE_KEY_B64", raising=False)
    get_settings.cache_clear()
    get_engine.cache_clear()
    get_sessionmaker.cache_clear()
    yield
    if get_engine.cache_info().currsize:
        await get_engine().dispose()
    get_settings.cache_clear()
    get_engine.cache_clear()
    get_sessionmaker.cache_clear()


@pytest.fixture
async def clean_db():
    """Truncate all sync tables; use in any test that writes rows."""
    async with get_engine().begin() as conn:
        await conn.execute(
            text(
                "TRUNCATE installations, repositories, issues, sync_jobs "
                "RESTART IDENTITY CASCADE"
            )
        )
    yield
```

Notes for the implementer:
- `test_database` is a **sync** fixture on purpose: `asyncio.run()` for the one-off asyncpg call and a **subprocess** for alembic. `backend/alembic/env.py` calls `asyncio.run()` internally, so it must run in a fresh process, not inside pytest-asyncio's loop.
- `asyncpg.connect` takes the plain `postgresql://` DSN (no `+asyncpg` suffix — that suffix is SQLAlchemy-only).
- Migration `0001_enable_pgvector.py` runs `CREATE EXTENSION vector` — this works because `issuelens` is the container superuser and the image is `pgvector/pg17`.

- [ ] **Step 3: Run the full backend suite**

Run (in `backend/`): `uv run pytest -q`
Expected: same pass/fail profile as before this task (all green; `test_worker.py::test_ping_job_round_trip` needs the worker container running, same as before).

- [ ] **Step 4: Verify the dev DB is untouched and the test DB exists**

Run:
```sh
docker compose exec postgres psql -U issuelens -d issuelens -t -c "SELECT count(*) FROM issues"
docker compose exec postgres psql -U issuelens -d issuelens_test -t -c "SELECT count(*) FROM issues"
```
Expected: first command still prints `N_DEV` from Step 1 (dogfood data intact). Second prints `0` (or whatever the last test left — the point is the DB exists and has the schema).

- [ ] **Step 5: Commit**

```bash
git add backend/tests/conftest.py
git commit -m "fix(tests): run pytest against dedicated issuelens_test database (#19)"
```

---

### Task 2: Ollama settings + docker-compose service

**Files:**
- Modify: `backend/app/config.py`
- Modify: `backend/tests/conftest.py` (pin the two new env vars in `pin_env`)
- Modify: `docker-compose.yml`
- Modify: `README.md`
- Test: `backend/tests/test_config.py` (new)

**Interfaces:**
- Produces: `get_settings().ollama_url` (default `http://localhost:11434`) and `get_settings().ollama_model` (default `qwen3:8b`). Tests see pinned values `http://127.0.0.1:11434` / `test-model` via `pin_env`. Compose gains an `ollama` service; the `worker` service gets `ISSUELENS_OLLAMA_URL: http://ollama:11434`.

- [ ] **Step 1: Write the failing test**

Create `backend/tests/test_config.py`:

```python
from app.config import get_settings


def test_ollama_settings_read_from_env():
    # pin_env (autouse) sets ISSUELENS_OLLAMA_URL / ISSUELENS_OLLAMA_MODEL,
    # proving the ISSUELENS_ prefix wiring works end to end.
    settings = get_settings()
    assert settings.ollama_url == "http://127.0.0.1:11434"
    assert settings.ollama_model == "test-model"
```

- [ ] **Step 2: Run test to verify it fails**

Run (in `backend/`): `uv run pytest tests/test_config.py -v`
Expected: FAIL — `AttributeError: 'Settings' object has no attribute 'ollama_url'` (pin_env doesn't set the vars yet either).

- [ ] **Step 3: Add the settings and pin them in tests**

In `backend/app/config.py`, add two fields to `Settings` after `redis_url`:

```python
    ollama_url: str = "http://localhost:11434"
    ollama_model: str = "qwen3:8b"
```

In `backend/tests/conftest.py`, inside `pin_env`, add after the `ISSUELENS_REDIS_URL` line:

```python
    monkeypatch.setenv("ISSUELENS_OLLAMA_URL", "http://127.0.0.1:11434")
    monkeypatch.setenv("ISSUELENS_OLLAMA_MODEL", "test-model")
```

- [ ] **Step 4: Run test to verify it passes**

Run: `uv run pytest tests/test_config.py -v`
Expected: PASS

- [ ] **Step 5: Add the ollama service to docker-compose**

In `docker-compose.yml`:

1. Add a new top-level service (sibling of `postgres`/`redis`):

```yaml
  ollama:
    image: ollama/ollama
    ports:
      - "127.0.0.1:11434:11434"
    volumes:
      - ollamadata:/root/.ollama
    deploy:
      resources:
        reservations:
          devices:
            - driver: nvidia
              count: all
              capabilities: [gpu]
```

2. In the `worker` service's `environment` block, add:

```yaml
      ISSUELENS_OLLAMA_URL: http://ollama:11434
```

3. In the top-level `volumes:` block at the bottom, add `ollamadata:` under `pgdata:`:

```yaml
volumes:
  pgdata:
  ollamadata:
```

Do NOT add `depends_on: ollama` to the worker — the worker must start and sync even when Ollama is down (classification simply fails and retries).

- [ ] **Step 6: Validate compose config and start the service**

Run: `docker compose config --quiet && docker compose up -d ollama && docker compose ps ollama`
Expected: no config errors; `ollama` service shows `Up`. (If the machine lacks the NVIDIA container runtime, `docker compose up -d ollama` errors on the device reservation — in that case remove the `deploy:` block, rerun, and note the CPU fallback in the task report.)

Then: `curl -s http://127.0.0.1:11434/api/version`
Expected: JSON like `{"version":"..."}`.

- [ ] **Step 7: Update README**

In `README.md`, in the `## Quickstart` section, after the line "Then run migrations once: `cd backend && uv run alembic upgrade head`", add:

```markdown
The first classification run downloads the local LLM (`qwen3:8b`, ~5 GB) into the
`ollamadata` volume — watch progress with `docker compose logs -f ollama`. Issue
type/component classification runs automatically after each repo sync.
```

- [ ] **Step 8: Run the full backend suite + commit**

Run: `uv run pytest -q`
Expected: all green.

```bash
git add backend/app/config.py backend/tests/conftest.py backend/tests/test_config.py docker-compose.yml README.md
git commit -m "feat: add Ollama service and settings for local-LLM classification"
```

---

### Task 3: Ollama client (`app/llm/ollama.py`)

**Files:**
- Create: `backend/app/llm/__init__.py` (empty)
- Create: `backend/app/llm/ollama.py`
- Test: `backend/tests/test_ollama.py` (new)

**Interfaces:**
- Consumes: `get_settings().ollama_url` / `.ollama_model` (Task 2).
- Produces (used by Tasks 5–6):
  - `ISSUE_TYPES: tuple[str, ...]` — `("bug", "feature", "debt", "question", "docs")`
  - `class ClassificationError(Exception)`
  - `make_ollama_client() -> httpx.AsyncClient` (base_url = settings.ollama_url)
  - `async ensure_model(client: httpx.AsyncClient) -> None`
  - `async classify(client: httpx.AsyncClient, prompt: str) -> dict` returning normalized `{"type": str, "component": str | None, "confidence": float}`

- [ ] **Step 1: Write the failing tests**

Create `backend/tests/test_ollama.py`:

```python
import json

import httpx
import pytest
import respx

from app.llm.ollama import (
    ClassificationError,
    classify,
    ensure_model,
    make_ollama_client,
)

BASE = "http://127.0.0.1:11434"


def chat_json(payload: dict) -> dict:
    return {"message": {"role": "assistant", "content": json.dumps(payload)}}


@respx.mock(base_url=BASE)
async def test_ensure_model_noop_when_present(respx_mock):
    respx_mock.get("/api/tags").respond(json={"models": [{"name": "test-model"}]})
    pull = respx_mock.post("/api/pull").respond(json={"status": "success"})
    async with make_ollama_client() as client:
        await ensure_model(client)
    assert pull.call_count == 0


@respx.mock(base_url=BASE)
async def test_ensure_model_pulls_when_missing(respx_mock):
    respx_mock.get("/api/tags").respond(json={"models": []})
    pull = respx_mock.post("/api/pull").respond(json={"status": "success"})
    async with make_ollama_client() as client:
        await ensure_model(client)
    assert pull.call_count == 1
    assert json.loads(pull.calls[0].request.content) == {
        "model": "test-model",
        "stream": False,
    }


@respx.mock(base_url=BASE)
async def test_classify_returns_normalized_result(respx_mock):
    route = respx_mock.post("/api/chat").respond(
        json=chat_json({"type": "bug", "component": "  Auth ", "confidence": 1.7})
    )
    async with make_ollama_client() as client:
        result = await classify(client, "some prompt")
    assert result == {"type": "bug", "component": "auth", "confidence": 1.0}
    body = json.loads(route.calls[0].request.content)
    assert body["model"] == "test-model"
    assert body["stream"] is False
    assert body["think"] is False
    assert body["options"] == {"temperature": 0}
    assert body["format"]["properties"]["type"]["enum"] == [
        "bug", "feature", "debt", "question", "docs",
    ]
    assert body["messages"] == [{"role": "user", "content": "some prompt"}]


@respx.mock(base_url=BASE)
async def test_classify_empty_component_becomes_null(respx_mock):
    respx_mock.post("/api/chat").respond(
        json=chat_json({"type": "docs", "component": "   ", "confidence": 0.5})
    )
    async with make_ollama_client() as client:
        result = await classify(client, "p")
    assert result["component"] is None


@respx.mock(base_url=BASE)
async def test_classify_invalid_type_raises(respx_mock):
    respx_mock.post("/api/chat").respond(
        json=chat_json({"type": "epic", "component": None, "confidence": 0.5})
    )
    async with make_ollama_client() as client:
        with pytest.raises(ClassificationError):
            await classify(client, "p")


@respx.mock(base_url=BASE)
async def test_classify_non_json_content_raises(respx_mock):
    respx_mock.post("/api/chat").respond(
        json={"message": {"role": "assistant", "content": "sorry, I cannot"}}
    )
    async with make_ollama_client() as client:
        with pytest.raises(ClassificationError):
            await classify(client, "p")


@respx.mock(base_url=BASE)
async def test_classify_http_error_propagates(respx_mock):
    respx_mock.post("/api/chat").respond(status_code=500)
    async with make_ollama_client() as client:
        with pytest.raises(httpx.HTTPStatusError):
            await classify(client, "p")
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `uv run pytest tests/test_ollama.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'app.llm'`

- [ ] **Step 3: Implement the client**

Create empty `backend/app/llm/__init__.py`, then `backend/app/llm/ollama.py`:

```python
import json
import logging
from typing import Any

import httpx

from app.config import get_settings

logger = logging.getLogger(__name__)

ISSUE_TYPES = ("bug", "feature", "debt", "question", "docs")
MAX_COMPONENT_LENGTH = 60

CLASSIFICATION_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "type": {"type": "string", "enum": list(ISSUE_TYPES)},
        "component": {"type": ["string", "null"]},
        "confidence": {"type": "number"},
    },
    "required": ["type", "component", "confidence"],
}


class ClassificationError(Exception):
    """The model returned output we could not use for this issue."""


def make_ollama_client() -> httpx.AsyncClient:
    return httpx.AsyncClient(
        base_url=get_settings().ollama_url,
        timeout=httpx.Timeout(120.0, connect=5.0),
    )


async def ensure_model(client: httpx.AsyncClient) -> None:
    """Pull the configured model on first use so the stack bootstraps itself."""
    model = get_settings().ollama_model
    resp = await client.get("/api/tags")
    resp.raise_for_status()
    names = {m["name"] for m in resp.json().get("models", [])}
    if model in names or f"{model}:latest" in names:
        return
    logger.info("pulling ollama model %s (first run; this can take minutes)", model)
    resp = await client.post(
        "/api/pull", json={"model": model, "stream": False}, timeout=None
    )
    resp.raise_for_status()


def _normalize(raw: dict[str, Any]) -> dict[str, Any]:
    issue_type = raw.get("type")
    if issue_type not in ISSUE_TYPES:
        raise ClassificationError(f"invalid type: {issue_type!r}")
    component = raw.get("component")
    if isinstance(component, str):
        component = component.strip().lower()[:MAX_COMPONENT_LENGTH] or None
    elif component is not None:
        raise ClassificationError(f"invalid component: {component!r}")
    try:
        confidence = min(1.0, max(0.0, float(raw["confidence"])))
    except (KeyError, TypeError, ValueError) as exc:
        raise ClassificationError(f"invalid confidence: {raw.get('confidence')!r}") from exc
    return {"type": issue_type, "component": component, "confidence": confidence}


async def classify(client: httpx.AsyncClient, prompt: str) -> dict[str, Any]:
    resp = await client.post(
        "/api/chat",
        json={
            "model": get_settings().ollama_model,
            "messages": [{"role": "user", "content": prompt}],
            "stream": False,
            "think": False,
            "format": CLASSIFICATION_SCHEMA,
            "options": {"temperature": 0},
        },
    )
    resp.raise_for_status()
    content = resp.json()["message"]["content"]
    try:
        raw = json.loads(content)
    except json.JSONDecodeError as exc:
        raise ClassificationError(f"model returned non-JSON: {content[:200]!r}") from exc
    return _normalize(raw)
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `uv run pytest tests/test_ollama.py -v`
Expected: 7 PASS

- [ ] **Step 5: Lint + commit**

Run: `uv run ruff check .`
Expected: clean.

```bash
git add backend/app/llm backend/tests/test_ollama.py
git commit -m "feat: httpx Ollama client with schema-constrained classification"
```

---

### Task 4: `IssueClassification` model + migration 0004

**Files:**
- Modify: `backend/app/models.py`
- Create: `backend/alembic/versions/0004_issue_classifications.py`
- Modify: `backend/tests/conftest.py` (add table to `clean_db` truncate list)
- Test: `backend/tests/test_models.py` (append)

**Interfaces:**
- Produces (used by Tasks 5, 7): ORM class `IssueClassification` with columns `issue_id: int` (PK, FK issues.id CASCADE), `issue_type: str`, `component: str | None`, `confidence: float`, `model: str`, `classified_at: datetime`, `issue_gh_updated_at: datetime`. Table name `issue_classifications`.

- [ ] **Step 1: Write the failing test**

Append to `backend/tests/test_models.py`:

```python
async def test_issue_classification_round_trip_and_cascade(clean_db):
    from datetime import datetime, timezone

    from sqlalchemy import delete, select

    from app.db import get_sessionmaker
    from app.models import Installation, Issue, IssueClassification, Repository

    now = datetime.now(timezone.utc)
    async with get_sessionmaker()() as session:
        session.add(Installation(id=1, account_login="octo"))
        session.add(
            Repository(id=10, installation_id=1, full_name="octo/r", owner="octo", name="r")
        )
        await session.flush()
        session.add(
            Issue(
                id=100, repository_id=10, number=1, title="t", state="open",
                gh_created_at=now, gh_updated_at=now,
            )
        )
        await session.flush()
        session.add(
            IssueClassification(
                issue_id=100, issue_type="bug", component="auth",
                confidence=0.9, model="test-model", issue_gh_updated_at=now,
            )
        )
        await session.commit()

        row = (
            await session.execute(
                select(IssueClassification).where(IssueClassification.issue_id == 100)
            )
        ).scalar_one()
        assert row.issue_type == "bug"
        assert row.component == "auth"
        assert row.classified_at is not None

        await session.execute(delete(Issue).where(Issue.id == 100))
        await session.commit()
        gone = (
            await session.execute(
                select(IssueClassification).where(IssueClassification.issue_id == 100)
            )
        ).scalar_one_or_none()
        assert gone is None
```

- [ ] **Step 2: Run test to verify it fails**

Run: `uv run pytest tests/test_models.py -v -k classification`
Expected: FAIL — `ImportError: cannot import name 'IssueClassification'`

- [ ] **Step 3: Add the ORM model**

In `backend/app/models.py`:

1. Extend the `sqlalchemy` import to include `Double`:

```python
from sqlalchemy import (
    BigInteger,
    Boolean,
    DateTime,
    Double,
    ForeignKey,
    Index,
    Integer,
    Text,
    UniqueConstraint,
    func,
    text,
)
```

2. Add after the `Issue` class (before `SyncJob`):

```python
class IssueClassification(Base):
    __tablename__ = "issue_classifications"

    issue_id: Mapped[int] = mapped_column(
        BigInteger, ForeignKey("issues.id", ondelete="CASCADE"), primary_key=True
    )
    issue_type: Mapped[str] = mapped_column(Text)
    component: Mapped[str | None] = mapped_column(Text, nullable=True)
    confidence: Mapped[float] = mapped_column(Double)
    model: Mapped[str] = mapped_column(Text)
    classified_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
    issue_gh_updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
```

- [ ] **Step 4: Write migration 0004**

Create `backend/alembic/versions/0004_issue_classifications.py`:

```python
"""issue classifications"""

import sqlalchemy as sa
from alembic import op

revision = "0004"
down_revision = "0003"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "issue_classifications",
        sa.Column(
            "issue_id",
            sa.BigInteger(),
            sa.ForeignKey("issues.id", ondelete="CASCADE"),
            primary_key=True,
        ),
        sa.Column("issue_type", sa.Text(), nullable=False),
        sa.Column("component", sa.Text(), nullable=True),
        sa.Column("confidence", sa.Double(), nullable=False),
        sa.Column("model", sa.Text(), nullable=False),
        sa.Column(
            "classified_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column("issue_gh_updated_at", sa.DateTime(timezone=True), nullable=False),
    )


def downgrade() -> None:
    op.drop_table("issue_classifications")
```

- [ ] **Step 5: Add the table to `clean_db`**

In `backend/tests/conftest.py`, change the `clean_db` TRUNCATE statement to:

```python
            text(
                "TRUNCATE installations, repositories, issues, issue_classifications, "
                "sync_jobs RESTART IDENTITY CASCADE"
            )
```

- [ ] **Step 6: Apply the migration to the dev DB and run tests**

Run:
```sh
uv run alembic upgrade head
uv run pytest tests/test_models.py -v
```
Expected: migration applies cleanly (the test DB is migrated automatically by the session fixture); all model tests PASS.

- [ ] **Step 7: Commit**

```bash
git add backend/app/models.py backend/alembic/versions/0004_issue_classifications.py backend/tests/conftest.py backend/tests/test_models.py
git commit -m "feat: issue_classifications table and ORM model"
```

---

### Task 5: Classification job (`app/llm/classify.py`)

**Files:**
- Create: `backend/app/llm/classify.py`
- Test: `backend/tests/test_classify.py` (new)

**Interfaces:**
- Consumes: `ensure_model`, `classify`, `ClassificationError`, `make_ollama_client` (Task 3); `IssueClassification` (Task 4); `Issue`, `Repository`, `SyncJob` (existing).
- Produces (used by Task 6):
  - `async classify_repository_issues(session: AsyncSession, client: httpx.AsyncClient, repo_id: int) -> int` — classifies all stale non-PR issues, records a `SyncJob(kind="classify")`, returns count classified.
  - `stale_issues_query(repo_id: int) -> Select` — the staleness predicate.
  - `build_prompt(repo_full_name: str, issue: Issue, known_components: list[str], repo_labels: list[str]) -> str`

- [ ] **Step 1: Write the failing tests**

Create `backend/tests/test_classify.py`:

```python
import json
from datetime import datetime, timedelta, timezone

import httpx
import pytest
import respx
from sqlalchemy import select

from app.db import get_sessionmaker
from app.llm.classify import build_prompt, classify_repository_issues, stale_issues_query
from app.llm.ollama import make_ollama_client
from app.models import Installation, Issue, IssueClassification, Repository, SyncJob

BASE = "http://127.0.0.1:11434"
NOW = datetime.now(timezone.utc)

TAGS_OK = {"models": [{"name": "test-model"}]}


def chat_json(payload: dict) -> httpx.Response:
    return httpx.Response(
        200, json={"message": {"role": "assistant", "content": json.dumps(payload)}}
    )


async def seed_repo_with_issues():
    async with get_sessionmaker()() as session:
        session.add(Installation(id=42, account_login="patelmj"))
        session.add(
            Repository(id=500, installation_id=42, full_name="patelmj/mehova",
                       owner="patelmj", name="mehova")
        )
        await session.flush()
        session.add(
            Issue(
                id=1, repository_id=500, number=1, title="Login crashes", state="open",
                body="Stack trace attached", labels=[{"name": "bug", "color": "d73a4a"}],
                gh_created_at=NOW - timedelta(days=5),
                gh_updated_at=NOW - timedelta(days=1),
            )
        )
        session.add(
            Issue(
                id=2, repository_id=500, number=2, title="Add dark mode", state="open",
                labels=[], gh_created_at=NOW - timedelta(days=4),
                gh_updated_at=NOW - timedelta(days=2),
            )
        )
        session.add(
            Issue(
                id=3, repository_id=500, number=3, title="Some PR", state="open",
                is_pull_request=True, gh_created_at=NOW, gh_updated_at=NOW,
            )
        )
        await session.commit()


async def run_job() -> int:
    async with get_sessionmaker()() as session, make_ollama_client() as client:
        return await classify_repository_issues(session, client, 500)


async def fetch_all_classifications() -> dict[int, IssueClassification]:
    async with get_sessionmaker()() as session:
        rows = (await session.execute(select(IssueClassification))).scalars()
        return {row.issue_id: row for row in rows}


async def fetch_classify_jobs() -> list[SyncJob]:
    async with get_sessionmaker()() as session:
        return list(
            (
                await session.execute(
                    select(SyncJob).where(SyncJob.kind == "classify").order_by(SyncJob.id)
                )
            ).scalars()
        )


@respx.mock(base_url=BASE)
async def test_classifies_stale_issues_and_records_job(clean_db, respx_mock):
    await seed_repo_with_issues()
    respx_mock.get("/api/tags").respond(json=TAGS_OK)
    chat = respx_mock.post("/api/chat")
    chat.side_effect = [
        chat_json({"type": "bug", "component": "auth", "confidence": 0.9}),
        chat_json({"type": "feature", "component": None, "confidence": 0.6}),
    ]

    assert await run_job() == 2

    rows = await fetch_all_classifications()
    assert set(rows) == {1, 2}  # the PR (id=3) is never classified
    assert rows[1].issue_type == "bug"
    assert rows[1].component == "auth"
    assert rows[1].model == "test-model"
    assert rows[2].issue_type == "feature"
    assert rows[2].component is None

    jobs = await fetch_classify_jobs()
    assert len(jobs) == 1
    assert jobs[0].status == "success"
    assert jobs[0].issues_upserted == 2
    assert jobs[0].finished_at is not None


@respx.mock(base_url=BASE)
async def test_second_run_skips_fresh_issues(clean_db, respx_mock):
    await seed_repo_with_issues()
    respx_mock.get("/api/tags").respond(json=TAGS_OK)
    chat = respx_mock.post("/api/chat")
    chat.side_effect = [
        chat_json({"type": "bug", "component": "auth", "confidence": 0.9}),
        chat_json({"type": "feature", "component": None, "confidence": 0.6}),
    ]
    assert await run_job() == 2
    assert chat.call_count == 2

    # Nothing stale -> no further chat calls
    assert await run_job() == 0
    assert chat.call_count == 2

    # Touch issue 1 on GitHub -> exactly one re-classification
    async with get_sessionmaker()() as session:
        issue = (await session.execute(select(Issue).where(Issue.id == 1))).scalar_one()
        issue.gh_updated_at = NOW
        await session.commit()
    chat.side_effect = [
        chat_json({"type": "debt", "component": "auth", "confidence": 0.8}),
    ]
    assert await run_job() == 1
    rows = await fetch_all_classifications()
    assert rows[1].issue_type == "debt"


@respx.mock(base_url=BASE)
async def test_per_issue_failure_skips_and_stays_stale(clean_db, respx_mock):
    await seed_repo_with_issues()
    respx_mock.get("/api/tags").respond(json=TAGS_OK)
    chat = respx_mock.post("/api/chat")
    chat.side_effect = [
        httpx.Response(500),
        chat_json({"type": "feature", "component": "ui", "confidence": 0.7}),
    ]

    assert await run_job() == 1

    rows = await fetch_all_classifications()
    assert set(rows) == {2}
    jobs = await fetch_classify_jobs()
    assert jobs[0].status == "success" and jobs[0].issues_upserted == 1

    # Issue 1 is still stale and would be retried
    async with get_sessionmaker()() as session:
        stale = list((await session.execute(stale_issues_query(500))).scalars())
    assert [i.id for i in stale] == [1]


@respx.mock(base_url=BASE)
async def test_ollama_down_marks_job_error_and_raises(clean_db, respx_mock):
    await seed_repo_with_issues()
    respx_mock.get("/api/tags").mock(side_effect=httpx.ConnectError("refused"))

    with pytest.raises(httpx.ConnectError):
        await run_job()

    jobs = await fetch_classify_jobs()
    assert len(jobs) == 1
    assert jobs[0].status == "error"
    assert jobs[0].error is not None


@respx.mock(base_url=BASE)
async def test_missing_model_is_pulled_before_classifying(clean_db, respx_mock):
    await seed_repo_with_issues()
    respx_mock.get("/api/tags").respond(json={"models": []})
    pull = respx_mock.post("/api/pull").respond(json={"status": "success"})
    chat = respx_mock.post("/api/chat")
    chat.side_effect = [
        chat_json({"type": "bug", "component": None, "confidence": 0.5}),
        chat_json({"type": "docs", "component": None, "confidence": 0.5}),
    ]
    assert await run_job() == 2
    assert pull.call_count == 1


async def test_prompt_contains_hints_and_truncates_body(clean_db):
    await seed_repo_with_issues()
    async with get_sessionmaker()() as session:
        issue = (await session.execute(select(Issue).where(Issue.id == 1))).scalar_one()
    prompt = build_prompt("patelmj/mehova", issue, ["auth", "sync"], ["bug", "feature"])
    assert "patelmj/mehova" in prompt
    assert "auth, sync" in prompt
    assert "bug, feature" in prompt
    assert "Login crashes" in prompt

    issue.body = "x" * 10_000
    long_prompt = build_prompt("patelmj/mehova", issue, [], [])
    assert "x" * 4000 in long_prompt
    assert "x" * 4001 not in long_prompt
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `uv run pytest tests/test_classify.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'app.llm.classify'`

- [ ] **Step 3: Implement the job**

Create `backend/app/llm/classify.py`:

```python
import logging

import httpx
from sqlalchemy import Select, func, select, text
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import get_settings
from app.llm.ollama import ClassificationError, classify, ensure_model
from app.models import Issue, IssueClassification, Repository, SyncJob

logger = logging.getLogger(__name__)

MAX_BODY_CHARS = 4000

PROMPT_TEMPLATE = """You are classifying a GitHub issue for a developer dashboard.

Repository: {repo_full_name}
Known components in this repository: {known_components}
Repository label names: {repo_labels}

Issue title: {title}
Issue labels: {issue_labels}
Issue body:
{body}

Classify the issue:
- "type": one of "bug" (defect in existing behavior), "feature" (new capability or \
enhancement), "debt" (refactoring, cleanup, or technical debt), "question" (support \
question or discussion), "docs" (documentation).
- "component": a short lowercase name for the code area this issue belongs to \
(for example "auth", "sync", "frontend"). Reuse a known component when one fits. \
Use null if you cannot tell.
- "confidence": your confidence in this classification from 0 to 1.
"""


def build_prompt(
    repo_full_name: str,
    issue: Issue,
    known_components: list[str],
    repo_labels: list[str],
) -> str:
    return PROMPT_TEMPLATE.format(
        repo_full_name=repo_full_name,
        known_components=", ".join(known_components) or "none yet",
        repo_labels=", ".join(repo_labels) or "none",
        title=issue.title,
        issue_labels=", ".join(lb["name"] for lb in issue.labels) or "none",
        body=(issue.body or "")[:MAX_BODY_CHARS] or "(empty)",
    )


def stale_issues_query(repo_id: int) -> Select:
    """Issues with no classification, or updated on GitHub since classification."""
    return (
        select(Issue)
        .outerjoin(IssueClassification, IssueClassification.issue_id == Issue.id)
        .where(
            Issue.repository_id == repo_id,
            Issue.is_pull_request.is_(False),
            IssueClassification.issue_id.is_(None)
            | (Issue.gh_updated_at > IssueClassification.issue_gh_updated_at),
        )
        .order_by(Issue.id)
    )


async def _repo_hints(
    session: AsyncSession, repo_id: int
) -> tuple[list[str], list[str]]:
    components = list(
        (
            await session.execute(
                select(IssueClassification.component)
                .join(Issue, Issue.id == IssueClassification.issue_id)
                .where(
                    Issue.repository_id == repo_id,
                    IssueClassification.component.is_not(None),
                )
                .distinct()
                .order_by(IssueClassification.component)
            )
        ).scalars()
    )
    labels = list(
        (
            await session.execute(
                text(
                    "SELECT DISTINCT elem->>'name' AS name "
                    "FROM issues, jsonb_array_elements(labels) AS elem "
                    "WHERE repository_id = :repo_id AND NOT is_pull_request "
                    "ORDER BY name"
                ),
                {"repo_id": repo_id},
            )
        ).scalars()
    )
    return components, labels


async def classify_repository_issues(
    session: AsyncSession, client: httpx.AsyncClient, repo_id: int
) -> int:
    repo = (
        await session.execute(select(Repository).where(Repository.id == repo_id))
    ).scalar_one()
    job = SyncJob(repository_id=repo_id, kind="classify", status="running")
    session.add(job)
    await session.commit()
    job_id = job.id
    try:
        await ensure_model(client)
        components, repo_labels = await _repo_hints(session, repo_id)
        issues = list((await session.execute(stale_issues_query(repo_id))).scalars())
        classified = 0
        for issue in issues:
            prompt = build_prompt(repo.full_name, issue, components, repo_labels)
            try:
                result = await classify(client, prompt)
            except (httpx.HTTPError, ClassificationError):
                logger.exception(
                    "classification failed for issue %s in repo %s", issue.id, repo_id
                )
                continue
            values = {
                "issue_id": issue.id,
                "issue_type": result["type"],
                "component": result["component"],
                "confidence": result["confidence"],
                "model": get_settings().ollama_model,
                "classified_at": func.now(),
                "issue_gh_updated_at": issue.gh_updated_at,
            }
            await session.execute(
                pg_insert(IssueClassification)
                .values(**values)
                .on_conflict_do_update(
                    index_elements=["issue_id"],
                    set_={k: v for k, v in values.items() if k != "issue_id"},
                )
            )
            await session.commit()
            if result["component"] is not None and result["component"] not in components:
                components.append(result["component"])
            classified += 1
        job.status = "success"
        job.issues_upserted = classified
        job.finished_at = func.now()
        await session.commit()
        return classified
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

Notes for the implementer:
- Per-issue `commit()` is deliberate: partial progress survives a crash mid-run, and the SyncJob error path can rollback safely without losing completed rows.
- Newly assigned components are appended to the in-memory `components` hints so later issues in the same run converge on the same vocabulary.

- [ ] **Step 4: Run tests to verify they pass**

Run: `uv run pytest tests/test_classify.py -v`
Expected: 6 PASS

- [ ] **Step 5: Lint + commit**

Run: `uv run ruff check .`
Expected: clean.

```bash
git add backend/app/llm/classify.py backend/tests/test_classify.py
git commit -m "feat: stale-driven classification job over Ollama"
```

---

### Task 6: Worker wiring — job registration, sync chaining, cron

**Files:**
- Modify: `backend/worker.py`
- Test: `backend/tests/test_classify_worker.py` (new)

**Interfaces:**
- Consumes: `classify_repository_issues` (Task 5), `make_ollama_client` (Task 3).
- Produces: arq job `classify_repository(ctx, repo_id) -> int`; `sync_repository` enqueues `classify_repository` with `_job_id=f"classify-{repo_id}"` after a successful sync; cron `classify_all_repositories` at minutes 15 and 45.

- [ ] **Step 1: Write the failing tests**

Create `backend/tests/test_classify_worker.py`:

```python
import worker


class FakeRedis:
    def __init__(self):
        self.calls = []

    async def enqueue_job(self, *args, **kwargs):
        self.calls.append((args, kwargs))
        return object()


async def test_sync_repository_enqueues_classification(monkeypatch):
    async def fake_sync(session, client, repo_id, full=False):
        return 3

    monkeypatch.setattr(worker, "sync_repository_issues", fake_sync)
    redis = FakeRedis()

    result = await worker.sync_repository({"redis": redis}, 500)

    assert result == 3
    assert redis.calls == [
        (("classify_repository", 500), {"_job_id": "classify-500"})
    ]


async def test_sync_repository_failure_does_not_enqueue(monkeypatch):
    async def failing_sync(session, client, repo_id, full=False):
        raise RuntimeError("github down")

    monkeypatch.setattr(worker, "sync_repository_issues", failing_sync)
    redis = FakeRedis()

    try:
        await worker.sync_repository({"redis": redis}, 500)
    except RuntimeError:
        pass
    else:
        raise AssertionError("expected RuntimeError")

    assert redis.calls == []


def test_worker_registers_classification_jobs():
    names = {fn.__name__ for fn in worker.WorkerSettings.functions}
    assert "classify_repository" in names
    cron_names = {job.name for job in worker.WorkerSettings.cron_jobs}
    assert "classify_all_repositories" in cron_names
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `uv run pytest tests/test_classify_worker.py -v`
Expected: FAIL — first test fails because no enqueue happens; registration test fails on missing names.

- [ ] **Step 3: Wire the worker**

Replace `backend/worker.py` with:

```python
import logging

from arq import cron
from arq.connections import RedisSettings

from app.config import get_settings
from app.db import get_sessionmaker
from app.github.client import make_http_client
from app.github.sync import sync_repository_issues
from app.llm.classify import classify_repository_issues
from app.llm.ollama import make_ollama_client

logger = logging.getLogger(__name__)


async def ping(ctx: dict) -> str:
    return "pong"


async def sync_repository(ctx: dict, repo_id: int, full: bool = False) -> int:
    async with get_sessionmaker()() as session, make_http_client() as client:
        count = await sync_repository_issues(session, client, repo_id, full=full)
    redis = ctx.get("redis")
    if redis is not None:
        await redis.enqueue_job(
            "classify_repository", repo_id, _job_id=f"classify-{repo_id}"
        )
    return count


async def classify_repository(ctx: dict, repo_id: int) -> int:
    async with get_sessionmaker()() as session, make_ollama_client() as client:
        return await classify_repository_issues(session, client, repo_id)


async def reconcile_all_repositories(ctx: dict) -> int:
    from sqlalchemy import select

    from app.models import Repository

    async with get_sessionmaker()() as session:
        repo_ids = list((await session.execute(select(Repository.id))).scalars())
    synced = 0
    for repo_id in repo_ids:
        try:
            await sync_repository(ctx, repo_id)
            synced += 1
        except Exception:
            logger.exception("reconcile failed for repo %s", repo_id)
    return synced


async def classify_all_repositories(ctx: dict) -> int:
    """Safety net for issues synced while Ollama was down."""
    from sqlalchemy import select

    from app.models import Repository

    async with get_sessionmaker()() as session:
        repo_ids = list((await session.execute(select(Repository.id))).scalars())
    done = 0
    for repo_id in repo_ids:
        try:
            await classify_repository(ctx, repo_id)
            done += 1
        except Exception:
            logger.exception("classification sweep failed for repo %s", repo_id)
    return done


class WorkerSettings:
    functions = [ping, sync_repository, classify_repository]
    cron_jobs = [
        cron(reconcile_all_repositories, name="reconcile_all_repositories", minute={0, 30}),
        cron(classify_all_repositories, name="classify_all_repositories", minute={15, 45}),
    ]
    redis_settings = RedisSettings.from_dsn(get_settings().redis_url)
    # keep_result=0: results are never read, and a retained result key would
    # block re-enqueueing the same _job_id for an hour after each sync
    keep_result = 0
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `uv run pytest tests/test_classify_worker.py -v`
Expected: 3 PASS

- [ ] **Step 5: Full suite, lint, commit**

Run: `uv run pytest -q && uv run ruff check .`
Expected: all green, lint clean.

```bash
git add backend/worker.py backend/tests/test_classify_worker.py
git commit -m "feat: classify_repository arq job chained after sync + cron sweep"
```

---

### Task 7: API — classification fields, filters, components facet

**Files:**
- Modify: `backend/app/routers/issues.py`
- Test: `backend/tests/test_api_issues.py` (append + small edits)

**Interfaces:**
- Consumes: `IssueClassification` (Task 4).
- Produces (used by Task 8): `IssueOut` gains `issue_type: str | None`, `component: str | None`, `classification_confidence: float | None`. `GET /issues` gains query params `type` (one of the 5 taxonomy values) and `component` (exact string). `GET /issues/facets` response gains `components: list[str]`.

- [ ] **Step 1: Write the failing tests**

Append to `backend/tests/test_api_issues.py`:

```python
from app.models import IssueClassification  # noqa: E402  (add to the top import block instead)


async def seed_classifications():
    async with get_sessionmaker()() as session:
        session.add(
            IssueClassification(
                issue_id=1, issue_type="bug", component="auth",
                confidence=0.9, model="test-model",
                issue_gh_updated_at=NOW - timedelta(days=1),
            )
        )
        session.add(
            IssueClassification(
                issue_id=4, issue_type="feature", component="sync",
                confidence=0.7, model="test-model",
                issue_gh_updated_at=NOW - timedelta(hours=3),
            )
        )
        await session.commit()


async def test_rows_include_classification_fields(clean_db, api):
    await seed_issues()
    await seed_classifications()
    body = await get_body(api, "/issues?sort=number&order=asc")
    by_title = {i["title"]: i for i in body["items"]}
    assert by_title["Alpha bug"]["issue_type"] == "bug"
    assert by_title["Alpha bug"]["component"] == "auth"
    assert by_title["Alpha bug"]["classification_confidence"] == 0.9
    assert by_title["Delta task"]["issue_type"] == "feature"


async def test_unclassified_rows_have_null_fields(clean_db, api):
    await seed_issues()
    body = await get_body(api, "/issues?state=all&q=beta")
    row = body["items"][0]
    assert row["issue_type"] is None
    assert row["component"] is None
    assert row["classification_confidence"] is None


async def test_type_filter(clean_db, api):
    await seed_issues()
    await seed_classifications()
    body = await get_body(api, "/issues?type=bug")
    assert [i["title"] for i in body["items"]] == ["Alpha bug"]


async def test_component_filter(clean_db, api):
    await seed_issues()
    await seed_classifications()
    body = await get_body(api, "/issues?component=sync")
    assert [i["title"] for i in body["items"]] == ["Delta task"]


async def test_bad_type_is_422(clean_db, api):
    async with api as client:
        assert (await client.get("/issues?type=epic")).status_code == 422


async def test_facets_include_components(clean_db, api):
    await seed_issues()
    await seed_classifications()
    body = await get_body(api, "/issues/facets")
    assert body["components"] == ["auth", "sync"]
    scoped = await get_body(api, "/issues/facets?repo_id=501")
    assert scoped["components"] == ["sync"]
```

Move the `IssueClassification` import into the existing `from app.models import ...` line at the top of the file (do not leave a mid-file import).

- [ ] **Step 2: Run tests to verify they fail**

Run: `uv run pytest tests/test_api_issues.py -v`
Expected: new tests FAIL (`KeyError: 'issue_type'`, `components` missing, 422 test fails because unknown params are ignored); pre-existing tests still PASS.

- [ ] **Step 3: Implement the API changes**

In `backend/app/routers/issues.py`:

1. Change the models import line to:

```python
from app.models import Issue, IssueClassification, Repository
```

2. Add a module-level alias after `ISSUE_FIELDS`:

```python
IssueType = Literal["bug", "feature", "debt", "question", "docs"]
```

3. Add three fields to `IssueOut` (after `gh_closed_at`):

```python
    issue_type: str | None
    component: str | None
    classification_confidence: float | None
```

4. Replace `_filtered_query` with:

```python
def _filtered_query(
    repo_id: int | None,
    state: str,
    label: str | None,
    assignee: str | None,
    q: str | None,
    issue_type: str | None,
    component: str | None,
) -> Select:
    query = (
        select(Issue, Repository.full_name, IssueClassification)
        .join(Repository, Issue.repository_id == Repository.id)
        .outerjoin(IssueClassification, IssueClassification.issue_id == Issue.id)
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
    if q:
        clause = Issue.title.ilike(f"%{_escape_like(q)}%")
        if q.isdigit():
            clause = clause | (Issue.number == int(q))
        query = query.where(clause)
    return query
```

5. Replace `list_issues` with:

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
    sort: Literal["updated", "created", "comments", "number", "title"] = "updated",
    order: Literal["asc", "desc"] = "desc",
    limit: int = Query(50, ge=1, le=100),
    offset: int = Query(0, ge=0),
) -> IssuePage:
    query = _filtered_query(repo_id, state, label, assignee, q, issue_type, component)
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
            issue_type=classification.issue_type if classification else None,
            component=classification.component if classification else None,
            classification_confidence=(
                classification.confidence if classification else None
            ),
            **{field: getattr(issue, field) for field in ISSUE_FIELDS},
        )
        for issue, full_name, classification in rows
    ]
    return IssuePage(items=items, total=total, limit=limit, offset=offset)
```

6. Add `components: list[str]` to `FacetsOut`:

```python
class FacetsOut(BaseModel):
    labels: list[LabelFacet]
    assignees: list[str]
    components: list[str]
```

7. In `issue_facets`, before the `return`, add:

```python
    comp_query = (
        select(IssueClassification.component)
        .join(Issue, Issue.id == IssueClassification.issue_id)
        .where(
            Issue.is_pull_request.is_(False),
            IssueClassification.component.is_not(None),
        )
        .distinct()
        .order_by(IssueClassification.component)
    )
    if repo_id is not None:
        comp_query = comp_query.where(Issue.repository_id == repo_id)
    components = list((await session.execute(comp_query)).scalars())
```

and change the return to include `components=components`:

```python
    return FacetsOut(
        labels=[LabelFacet(name=row.name, color=row.color or "") for row in label_rows],
        assignees=[row.login for row in assignee_rows],
        components=components,
    )
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `uv run pytest tests/test_api_issues.py -v`
Expected: all PASS (old and new).

- [ ] **Step 5: Full suite, lint, commit**

Run: `uv run pytest -q && uv run ruff check .`
Expected: green, clean.

```bash
git add backend/app/routers/issues.py backend/tests/test_api_issues.py
git commit -m "feat: expose classification fields, type/component filters, components facet"
```

---

### Task 8: Frontend — Type/Component columns + toolbar filters

**Files:**
- Modify: `frontend/src/app/globals.css`
- Modify: `frontend/src/app/plan/plan-client.tsx`
- Modify: `frontend/src/app/plan/toolbar.tsx`
- Test: `frontend/e2e/classification.spec.ts` (new)

**Interfaces:**
- Consumes: API fields `issue_type` / `component` / `classification_confidence`, params `type` / `component`, facets `components` (Task 7).
- Produces: `IssueRow` gains the three fields; `ColumnKey` gains `"type" | "component"`; `TableParams` gains `type: string | null` and `component: string | null`; CSS vars `--type-bug|feature|debt|question|docs` in both theme blocks.

- [ ] **Step 1: Add the type-color tokens**

In `frontend/src/app/globals.css`, add inside the `:root` (light) block after `--color-danger`:

```css
  --type-bug: #d1242f;
  --type-feature: #5b5bd6;
  --type-debt: #9a6700;
  --type-question: #1b7c83;
  --type-docs: #57606a;
```

and inside the `[data-mode="dark"]` block after its `--color-danger`:

```css
  --type-bug: #f47067;
  --type-feature: #7b7bec;
  --type-debt: #d4a72c;
  --type-question: #39c5cf;
  --type-docs: #9698a1;
```

(Outline-badge style per house rules: colored text + border, no solid fills; bug reuses the danger hue, feature the indigo accent.)

- [ ] **Step 2: Write the failing e2e test**

Create `frontend/e2e/classification.spec.ts`:

```typescript
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
  ...over,
});

const page1 = {
  items: [
    row({}),
    row({
      id: 2,
      number: 43,
      title: "Redis rate limiting",
      issue_type: null,
      component: null,
      classification_confidence: null,
    }),
  ],
  total: 2,
  limit: 50,
  offset: 0,
};

const repos = [{ id: 500, full_name: "patelmj/mehova" }];

const facets = {
  labels: [{ name: "bug", color: "d73a4a" }],
  assignees: ["patelmj"],
  components: ["auth", "sync"],
};

test("type and component columns render with muted unclassified state", async ({
  page,
}) => {
  await page.route(/\/api\/backend\/issues\?/, (route) =>
    route.fulfill({ json: page1 }),
  );
  await page.route(/\/api\/backend\/repositories$/, (route) =>
    route.fulfill({ json: repos }),
  );
  await page.route(/\/api\/backend\/issues\/facets/, (route) =>
    route.fulfill({ json: facets }),
  );
  await page.goto("/plan");
  await expect(page.getByText("Fix token refresh")).toBeVisible();

  const classifiedRow = page.getByRole("row").filter({ hasText: "Fix token refresh" });
  await expect(classifiedRow.getByTestId("type-cell")).toHaveText("bug");
  await expect(classifiedRow.getByTestId("component-cell")).toHaveText("auth");

  const unclassifiedRow = page
    .getByRole("row")
    .filter({ hasText: "Redis rate limiting" });
  await expect(unclassifiedRow.getByTestId("type-cell")).toHaveText("—");
  await expect(unclassifiedRow.getByTestId("component-cell")).toHaveText("—");
});

test("type and component filters round-trip to API and URL", async ({ page }) => {
  const requested: string[] = [];
  await page.route(/\/api\/backend\/issues\?/, (route) => {
    requested.push(route.request().url());
    return route.fulfill({ json: page1 });
  });
  await page.route(/\/api\/backend\/repositories$/, (route) =>
    route.fulfill({ json: repos }),
  );
  await page.route(/\/api\/backend\/issues\/facets/, (route) =>
    route.fulfill({ json: facets }),
  );
  await page.goto("/plan");
  await expect(page.getByText("Fix token refresh")).toBeVisible();

  await page.getByLabel("Type", { exact: true }).selectOption("bug");
  await expect(page).toHaveURL(/type=bug/);
  await expect
    .poll(() => requested.some((u) => u.includes("type=bug")))
    .toBe(true);

  await page.getByLabel("Component", { exact: true }).selectOption("auth");
  await expect(page).toHaveURL(/component=auth/);
  await expect
    .poll(() => requested.some((u) => u.includes("component=auth")))
    .toBe(true);
});
```

- [ ] **Step 3: Run the e2e test to verify it fails**

Run (in `frontend/`): `npx playwright test e2e/classification.spec.ts`
Expected: FAIL — no Type/Component cells or selects exist yet. (Playwright config starts the dev server; if a stale Docker frontend is running on the port, `docker compose restart frontend` first.)

- [ ] **Step 4: Implement `plan-client.tsx` changes**

In `frontend/src/app/plan/plan-client.tsx`:

1. Extend `IssueRow` (after `gh_closed_at`):

```typescript
  issue_type: "bug" | "feature" | "debt" | "question" | "docs" | null;
  component: string | null;
  classification_confidence: number | null;
```

2. Extend `ColumnKey` union — add `"type"` and `"component"` after `"title"`:

```typescript
export type ColumnKey =
  | "repo"
  | "number"
  | "title"
  | "type"
  | "component"
  | "labels"
  | "assignees"
  | "comments"
  | "updated"
  | "state"
  | "milestone"
  | "author"
  | "created";
```

3. Extend `TableParams`:

```typescript
export type TableParams = {
  repoId: string | null;
  state: string;
  label: string | null;
  assignee: string | null;
  q: string | null;
  type: string | null;
  component: string | null;
  setParams: (updates: Record<string, string | null>) => void;
};
```

4. In `COLUMNS`, insert after the `title` entry:

```typescript
  { key: "type", label: "Type", defaultVisible: true },
  { key: "component", label: "Component", defaultVisible: true },
```

5. Add a badge-class map next to `stateBadge` (static literal classes — Tailwind cannot extract interpolated names):

```typescript
const TYPE_BADGE: Record<string, string> = {
  bug: "text-(--type-bug) border-(--type-bug)",
  feature: "text-(--type-feature) border-(--type-feature)",
  debt: "text-(--type-debt) border-(--type-debt)",
  question: "text-(--type-question) border-(--type-question)",
  docs: "text-(--type-docs) border-(--type-docs)",
};
```

6. In `PlanClient`, read the new URL params after the `q` line:

```typescript
  const typeFilter = searchParams.get("type");
  const component = searchParams.get("component");
```

and forward them to the backend query after the `if (q) ...` line:

```typescript
  if (typeFilter) backendQuery.set("type", typeFilter);
  if (component) backendQuery.set("component", component);
```

7. Pass them to the toolbar:

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
          setParams,
        }}
        visible={visible}
        onToggleColumn={onToggleColumn}
      />
```

8. Render the two cells in the row, between the `title` cell and the `labels` cell:

```tsx
                    {visible.has("type") ? (
                      <td className="px-3 py-2" data-testid="type-cell">
                        {row.issue_type ? (
                          <span
                            className={`rounded-full border px-1.5 text-[10px] ${TYPE_BADGE[row.issue_type]}`}
                            title={
                              row.classification_confidence != null
                                ? `Confidence ${Math.round(row.classification_confidence * 100)}%`
                                : undefined
                            }
                          >
                            {row.issue_type}
                          </span>
                        ) : (
                          <span className="text-(--color-text-muted)">—</span>
                        )}
                      </td>
                    ) : null}
                    {visible.has("component") ? (
                      <td
                        className="px-3 py-2 whitespace-nowrap text-(--color-text-muted)"
                        data-testid="component-cell"
                      >
                        {row.component ?? "—"}
                      </td>
                    ) : null}
```

- [ ] **Step 5: Implement `toolbar.tsx` changes**

In `frontend/src/app/plan/toolbar.tsx`:

1. Update the `Facets` type:

```typescript
type Facets = {
  labels: { name: string; color: string }[];
  assignees: string[];
  components: string[];
};
```

2. Add the fixed type options after `STATES`:

```typescript
const TYPES = ["bug", "feature", "debt", "question", "docs"];
```

3. Destructure the new params — change the destructuring line to:

```typescript
  const { repoId, state, label, assignee, q, type, component, setParams } = params;
```

4. Add two selects after the assignee `<select>` (before `<div className="grow" />`):

```tsx
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
        aria-label="Component"
        className={control}
        value={component ?? ""}
        onChange={(e) =>
          setParams({ component: e.target.value || null, offset: null })
        }
      >
        <option value="">Any component</option>
        {(facets?.components ?? []).map((c) => (
          <option key={c} value={c}>
            {c}
          </option>
        ))}
      </select>
```

5. In the repository `<select>`'s `onChange`, also clear the component filter when switching repos (components are repo-scoped):

```tsx
        onChange={(e) =>
          setParams({
            repo_id: e.target.value || null,
            label: null,
            assignee: null,
            component: null,
            offset: null,
          })
        }
```

- [ ] **Step 6: Run lint, types, and e2e**

Run (in `frontend/`):
```sh
npm run lint
npx tsc --noEmit
npx playwright test
```
Expected: lint + types clean; ALL e2e specs pass (the new `classification.spec.ts` plus the pre-existing ones — their facets mocks lack `components`, which is fine because the toolbar uses `facets?.components ?? []`).

- [ ] **Step 7: Commit**

```bash
git add frontend/src/app/globals.css frontend/src/app/plan/plan-client.tsx frontend/src/app/plan/toolbar.tsx frontend/e2e/classification.spec.ts
git commit -m "feat: type/component columns and filters in issues table"
```

---

### Task 9: Rider #17 — wire header repo chip to live stats

**Files:**
- Modify: `frontend/src/components/header.tsx`
- Test: `frontend/e2e/shell.spec.ts` (append)

**Interfaces:**
- Consumes: existing `GET /stats/overview` (`connected_repos`, `open_issues`); shares the react-query cache key `["overview-stats"]` with `overview-client.tsx`.

- [ ] **Step 1: Write the failing e2e test**

Append to `frontend/e2e/shell.spec.ts`:

```typescript
test("header chip shows live repo stats", async ({ page }) => {
  await page.route(/\/api\/backend\/stats\/overview/, (route) =>
    route.fulfill({
      json: {
        connected_repos: 2,
        open_issues: 5,
        last_synced_at: null,
        top_repos: [],
        activity: [],
      },
    }),
  );
  await page.goto("/triage");
  await expect(page.getByTestId("header-chip")).toHaveText(
    "2 repos · 5 open issues",
  );
});

test("header chip shows empty state when nothing is connected", async ({
  page,
}) => {
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
  await page.goto("/triage");
  await expect(page.getByTestId("header-chip")).toHaveText(
    "No repository connected",
  );
});
```

(Check the existing imports at the top of `shell.spec.ts` — it already imports `expect, test` from `@playwright/test`; do not duplicate the import.)

- [ ] **Step 2: Run to verify it fails**

Run: `npx playwright test e2e/shell.spec.ts`
Expected: new tests FAIL (`header-chip` testid does not exist); pre-existing shell tests still pass.

- [ ] **Step 3: Implement the live header chip**

Replace `frontend/src/components/header.tsx` with:

```tsx
"use client";

import { useQuery } from "@tanstack/react-query";
import { getJson } from "../lib/api";
import { ThemeToggle } from "./theme-toggle";

type OverviewStats = {
  connected_repos: number;
  open_issues: number;
};

export function Header() {
  const { data } = useQuery({
    queryKey: ["overview-stats"],
    queryFn: () => getJson<OverviewStats>("/api/backend/stats/overview"),
    refetchInterval: 30_000,
  });

  const chip = !data
    ? "—"
    : data.connected_repos === 0
      ? "No repository connected"
      : `${data.connected_repos} repos · ${data.open_issues} open issues`;

  return (
    <header className="flex items-center gap-3 border-b border-(--color-border) px-5 py-2.5">
      <div className="flex items-center gap-1.5 font-semibold">
        <span className="inline-block h-2.5 w-2.5 rounded-full bg-(--color-primary)" />
        IssueLens
      </div>
      <span
        data-testid="header-chip"
        className="rounded-lg border border-(--color-border) bg-(--color-surface) px-2 py-1 text-(--color-text-muted)"
      >
        {chip}
      </span>
      <div className="grow" />
      <button
        type="button"
        disabled
        title="Command palette — coming soon"
        className="rounded-lg border border-(--color-border) bg-(--color-surface) px-2.5 py-1.5 text-(--color-text-muted)"
      >
        ⌘K
      </button>
      <ThemeToggle />
    </header>
  );
}
```

Notes: sharing `queryKey: ["overview-stats"]` with `overview-client.tsx` means one fetch feeds both (same endpoint). While loading or on error the chip shows a muted `—` — the element never disappears.

- [ ] **Step 4: Run lint + all e2e**

Run: `npm run lint && npx tsc --noEmit && npx playwright test`
Expected: clean; all specs pass (other specs don't mock `/stats/overview` — the header query just fails silently there and shows `—`, breaking no assertions).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/header.tsx frontend/e2e/shell.spec.ts
git commit -m "feat: wire header repo chip to live overview stats (#17)"
```

---

### Task 10: Rider #20 — test the top_repos 5-cap

**Files:**
- Test: `backend/tests/test_api_stats.py` (append)

**Interfaces:**
- Consumes: existing `GET /stats/overview` (`TOP_REPOS_LIMIT = 5`, ordered by `open_issues_count` desc then `full_name` asc).

- [ ] **Step 1: Write the failing-or-passing test (it should pass immediately — this is a coverage gap, not a bug)**

Append to `backend/tests/test_api_stats.py`:

```python
async def test_top_repos_capped_at_five_in_order(clean_db, api):
    async with get_sessionmaker()() as session:
        session.add(Installation(id=42, account_login="patelmj"))
        await session.flush()
        counts = {"r-a": 10, "r-b": 8, "r-c": 8, "r-d": 6, "r-e": 4, "r-f": 2}
        for idx, (name, count) in enumerate(counts.items()):
            session.add(
                Repository(
                    id=600 + idx, installation_id=42,
                    full_name=f"patelmj/{name}", owner="patelmj", name=name,
                    open_issues_count=count,
                )
            )
        await session.commit()

    async with api as client:
        resp = await client.get("/stats/overview")
    assert resp.status_code == 200
    top = resp.json()["top_repos"]
    assert len(top) == 5  # 6 repos seeded, cap is 5
    assert [r["full_name"] for r in top] == [
        "patelmj/r-a",   # 10
        "patelmj/r-b",   # 8 — ties broken by name asc
        "patelmj/r-c",   # 8
        "patelmj/r-d",   # 6
        "patelmj/r-e",   # 4
    ]
```

- [ ] **Step 2: Run it**

Run: `uv run pytest tests/test_api_stats.py -v -k top_repos`
Expected: PASS (the cap and ordering already exist; if it FAILS, the implementation has a real bug — report it, don't adjust the test).

- [ ] **Step 3: Commit**

```bash
git add backend/tests/test_api_stats.py
git commit -m "test: cover top_repos 5-cap and ordering in /stats/overview (#20)"
```

---

### Task 11: Full-suite gate + live verification

**Files:** none (verification only)

- [ ] **Step 1: Full backend gate**

Run (in `backend/`): `uv run pytest -q && uv run ruff check .`
Expected: all tests green, lint clean.

- [ ] **Step 2: Full frontend gate**

Run (in `frontend/`): `npm run lint && npx tsc --noEmit && npx playwright test`
Expected: clean, all e2e specs green.

- [ ] **Step 3: Live verification (real stack, real model)**

```sh
docker compose up -d --build
cd backend && uv run alembic upgrade head
```

Then:
1. `curl -s http://127.0.0.1:11434/api/version` — Ollama responds.
2. Trigger a sync on a small repo: open http://localhost:3005/repositories, click **Sync** on one repo (or `curl -X POST http://localhost:8000/repositories/<id>/sync`).
3. Watch the worker: `docker compose logs -f worker` — expect the sync job, then `classify_repository` (first run logs the model pull; ~5 GB download, watch `docker compose logs -f ollama`).
4. Verify rows landed:
   ```sh
   docker compose exec postgres psql -U issuelens -d issuelens -c \
     "SELECT issue_type, component, round(confidence::numeric, 2), count(*) FROM issue_classifications GROUP BY 1, 2, 3 ORDER BY 4 DESC LIMIT 20"
   ```
5. Verify job records: `SELECT kind, status, issues_upserted FROM sync_jobs ORDER BY id DESC LIMIT 5` shows a `classify` / `success` row.
6. Open http://localhost:3005/plan via Playwright CLI (per house testing rule) — confirm Type badges and Component values render on real issues, type/component filters narrow the table, and unclassified issues (if any remain mid-run) show muted `—`.
7. Header chip shows `N repos · M open issues` (rider #17 live check).
8. Re-run `uv run pytest -q` in `backend/`, then re-check step 4's dev-DB count query — dogfood data untouched (#19 acceptance).

- [ ] **Step 4: Wrap up**

Surface a summary of the slice and ask the user whether to open a PR (per CLAUDE.md PR-based review methodology — do NOT auto-open one).
