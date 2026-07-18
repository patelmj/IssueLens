# IssueLens GitHub Sync Slice Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** GitHub App auth + polling issue sync into Postgres via ARQ, driven from a real `/repositories` page.

**Architecture:** A thin in-house GitHub client (`httpx` + `PyJWT`) mints App JWTs and cached installation tokens; discovery and idempotent issue-upsert logic live in `app/github/sync.py`, executed by ARQ jobs (manual + 30-min reconciliation cron); a `/repositories` FastAPI router surfaces list/refresh/sync; the frontend Repositories page consumes it via the existing proxy with TanStack Query polling.

**Tech Stack:** additions — `httpx` (main), `pyjwt`, `cryptography`; dev `respx`. Everything else as in the foundation slice.

**Spec:** `docs/superpowers/specs/2026-07-18-github-sync-design.md` · Board issue [#3](https://github.com/patelmj/IssueLens/issues/3)

## Global Constraints

- Branch `feat/github-sync`; never commit to main; no AI attribution lines in commit messages.
- Env vars prefixed `ISSUELENS_`; `.env.example` updated in the same commit that introduces a var. Secrets only in `.env` (git-ignored).
- Backend tests pin env in fixtures (existing `pin_env`); GitHub is always `respx`-mocked in tests — no live GitHub calls in pytest or CI.
- Frontend: colors only via tokens, `bg-(--token)` parenthesis syntax (brackets forbidden), inactive elements visible-but-muted, dark default. New `--color-danger` token pair is the only globals.css change.
- Frontend runs on port **3005**. Backend errors use `{"detail": ...}`.
- Local test runs need `docker compose up -d postgres redis` (worker rebuilt/up for Task 5's round-trip). Migrations at head: `uv run alembic upgrade head`.
- The REST issues list includes pull requests — always flag `is_pull_request` (`"pull_request" in item`) and exclude PRs from `open_issues_count`.

---

### Task 1: Dependencies + settings + env plumbing

**Files:**
- Modify: `backend/pyproject.toml`, `backend/app/config.py`, `backend/tests/test_config.py`, `.env.example`

**Interfaces:**
- Consumes: existing `Settings`/`get_settings()`.
- Produces: `Settings.github_app_id: str | None` and `Settings.github_app_private_key_b64: str | None` (both default `None`); deps `httpx`, `pyjwt`, `cryptography` importable in main code; `respx` in dev.

- [ ] **Step 1: Branch**

```bash
git checkout main && git pull && git checkout -b feat/github-sync
```

- [ ] **Step 2: Update pyproject dependencies**

In `backend/pyproject.toml` add to `[project] dependencies`:

```toml
    "httpx>=0.27",
    "pyjwt>=2.9",
    "cryptography>=43",
```

(`httpx` stays in dev too — harmless duplication is fine; do not remove it there.) Add to `[dependency-groups] dev`:

```toml
    "respx>=0.21",
```

Run: `cd backend && uv sync` — resolves cleanly, updates `uv.lock`.

- [ ] **Step 3: Failing test for new settings**

Append to `backend/tests/test_config.py`:

```python
def test_github_app_settings_default_none():
    s = get_settings()
    assert s.github_app_id is None
    assert s.github_app_private_key_b64 is None


def test_github_app_settings_read_env(monkeypatch):
    monkeypatch.setenv("ISSUELENS_GITHUB_APP_ID", "12345")
    monkeypatch.setenv("ISSUELENS_GITHUB_APP_PRIVATE_KEY_B64", "cGVt")
    get_settings.cache_clear()
    s = get_settings()
    assert s.github_app_id == "12345"
    assert s.github_app_private_key_b64 == "cGVt"
```

Run: `uv run pytest tests/test_config.py -v` — expected: 2 new tests FAIL (attribute error).

- [ ] **Step 4: Implement settings fields**

In `backend/app/config.py`, add to `Settings`:

```python
    github_app_id: str | None = None
    github_app_private_key_b64: str | None = None
```

- [ ] **Step 5: Update .env.example**

Append:

```sh
# GitHub App (see README "GitHub App setup"; set real values in .env, never commit)
ISSUELENS_GITHUB_APP_ID=
ISSUELENS_GITHUB_APP_PRIVATE_KEY_B64=
```

- [ ] **Step 6: Verify and commit**

Run: `uv run pytest -v` (all pass) and `uv run ruff check .` (clean).

```bash
git add backend/pyproject.toml backend/uv.lock backend/app/config.py backend/tests/test_config.py .env.example
git commit -m "feat(backend): github app settings and client dependencies"
```

---

### Task 2: Models + migration 0002 + session factory

**Files:**
- Create: `backend/app/models.py`, `backend/alembic/versions/0002_github_sync_tables.py`, `backend/tests/test_models.py`
- Modify: `backend/app/db.py`, `backend/tests/conftest.py`

**Interfaces:**
- Consumes: `get_engine()` (Task 3 of foundation).
- Produces: SQLAlchemy models `Installation`, `Repository`, `Issue`, `SyncJob` in `app.models`; `app.db.get_sessionmaker() -> async_sessionmaker[AsyncSession]` (`@lru_cache`); FastAPI dependency `app.db.get_session` (async generator); pytest fixture `clean_db` (truncates all four tables). Migration `0002` (head).

- [ ] **Step 1: Write models**

`backend/app/models.py`:

```python
from datetime import datetime

from sqlalchemy import (
    BigInteger,
    Boolean,
    DateTime,
    ForeignKey,
    Integer,
    Text,
    UniqueConstraint,
    func,
)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column


class Base(DeclarativeBase):
    pass


class Installation(Base):
    __tablename__ = "installations"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    account_login: Mapped[str] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )


class Repository(Base):
    __tablename__ = "repositories"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    installation_id: Mapped[int] = mapped_column(
        BigInteger, ForeignKey("installations.id", ondelete="CASCADE")
    )
    full_name: Mapped[str] = mapped_column(Text)
    owner: Mapped[str] = mapped_column(Text)
    name: Mapped[str] = mapped_column(Text)
    private: Mapped[bool] = mapped_column(Boolean, default=False)
    last_synced_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    sync_status: Mapped[str] = mapped_column(Text, default="idle", server_default="idle")
    sync_error: Mapped[str | None] = mapped_column(Text, nullable=True)
    open_issues_count: Mapped[int] = mapped_column(Integer, default=0, server_default="0")


class Issue(Base):
    __tablename__ = "issues"
    __table_args__ = (
        UniqueConstraint("repository_id", "number", name="uq_issues_repo_number"),
    )

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    repository_id: Mapped[int] = mapped_column(
        BigInteger, ForeignKey("repositories.id", ondelete="CASCADE"), index=True
    )
    number: Mapped[int] = mapped_column(Integer)
    title: Mapped[str] = mapped_column(Text)
    body: Mapped[str | None] = mapped_column(Text, nullable=True)
    state: Mapped[str] = mapped_column(Text)
    author_login: Mapped[str] = mapped_column(Text, default="")
    labels: Mapped[list] = mapped_column(JSONB, default=list)
    assignees: Mapped[list] = mapped_column(JSONB, default=list)
    milestone_title: Mapped[str | None] = mapped_column(Text, nullable=True)
    comments_count: Mapped[int] = mapped_column(Integer, default=0)
    is_pull_request: Mapped[bool] = mapped_column(Boolean, default=False)
    gh_created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    gh_updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    gh_closed_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    synced_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )


class SyncJob(Base):
    __tablename__ = "sync_jobs"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    repository_id: Mapped[int] = mapped_column(
        BigInteger, ForeignKey("repositories.id", ondelete="CASCADE")
    )
    kind: Mapped[str] = mapped_column(Text)
    status: Mapped[str] = mapped_column(Text, default="running")
    started_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
    finished_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    issues_upserted: Mapped[int] = mapped_column(Integer, default=0)
    error: Mapped[str | None] = mapped_column(Text, nullable=True)
```

- [ ] **Step 2: Write migration**

`backend/alembic/versions/0002_github_sync_tables.py`:

```python
"""github sync tables"""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import JSONB

revision = "0002"
down_revision = "0001"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "installations",
        sa.Column("id", sa.BigInteger(), primary_key=True),
        sa.Column("account_login", sa.Text(), nullable=False),
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
    )
    op.create_table(
        "repositories",
        sa.Column("id", sa.BigInteger(), primary_key=True),
        sa.Column(
            "installation_id",
            sa.BigInteger(),
            sa.ForeignKey("installations.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("full_name", sa.Text(), nullable=False),
        sa.Column("owner", sa.Text(), nullable=False),
        sa.Column("name", sa.Text(), nullable=False),
        sa.Column("private", sa.Boolean(), server_default=sa.text("false"), nullable=False),
        sa.Column("last_synced_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("sync_status", sa.Text(), server_default="idle", nullable=False),
        sa.Column("sync_error", sa.Text(), nullable=True),
        sa.Column("open_issues_count", sa.Integer(), server_default="0", nullable=False),
    )
    op.create_table(
        "issues",
        sa.Column("id", sa.BigInteger(), primary_key=True),
        sa.Column(
            "repository_id",
            sa.BigInteger(),
            sa.ForeignKey("repositories.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("number", sa.Integer(), nullable=False),
        sa.Column("title", sa.Text(), nullable=False),
        sa.Column("body", sa.Text(), nullable=True),
        sa.Column("state", sa.Text(), nullable=False),
        sa.Column("author_login", sa.Text(), server_default="", nullable=False),
        sa.Column("labels", JSONB(), server_default=sa.text("'[]'::jsonb"), nullable=False),
        sa.Column(
            "assignees", JSONB(), server_default=sa.text("'[]'::jsonb"), nullable=False
        ),
        sa.Column("milestone_title", sa.Text(), nullable=True),
        sa.Column("comments_count", sa.Integer(), server_default="0", nullable=False),
        sa.Column(
            "is_pull_request", sa.Boolean(), server_default=sa.text("false"), nullable=False
        ),
        sa.Column("gh_created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("gh_updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("gh_closed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column(
            "synced_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.UniqueConstraint("repository_id", "number", name="uq_issues_repo_number"),
    )
    op.create_index("ix_issues_repository_id", "issues", ["repository_id"])
    op.create_table(
        "sync_jobs",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column(
            "repository_id",
            sa.BigInteger(),
            sa.ForeignKey("repositories.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("kind", sa.Text(), nullable=False),
        sa.Column("status", sa.Text(), server_default="running", nullable=False),
        sa.Column(
            "started_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column("finished_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("issues_upserted", sa.Integer(), server_default="0", nullable=False),
        sa.Column("error", sa.Text(), nullable=True),
    )


def downgrade() -> None:
    op.drop_table("sync_jobs")
    op.drop_index("ix_issues_repository_id", table_name="issues")
    op.drop_table("issues")
    op.drop_table("repositories")
    op.drop_table("installations")
```

- [ ] **Step 3: Session factory + FastAPI dependency**

Replace `backend/app/db.py` content:

```python
from collections.abc import AsyncIterator
from functools import lru_cache

from sqlalchemy.ext.asyncio import (
    AsyncEngine,
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)

from app.config import get_settings


@lru_cache(maxsize=1)
def get_engine() -> AsyncEngine:
    return create_async_engine(get_settings().database_url, pool_pre_ping=True)


@lru_cache(maxsize=1)
def get_sessionmaker() -> async_sessionmaker[AsyncSession]:
    return async_sessionmaker(get_engine(), expire_on_commit=False)


async def get_session() -> AsyncIterator[AsyncSession]:
    async with get_sessionmaker()() as session:
        yield session
```

- [ ] **Step 4: Update conftest (full replacement)**

`backend/tests/conftest.py`:

```python
import pytest
from sqlalchemy import text

from app.config import get_settings
from app.db import get_engine, get_sessionmaker


@pytest.fixture(autouse=True)
async def pin_env(monkeypatch):
    """Pin behavior-affecting env vars explicitly; never inherit host state silently."""
    monkeypatch.setenv(
        "ISSUELENS_DATABASE_URL",
        "postgresql+asyncpg://issuelens:issuelens@localhost:5432/issuelens",
    )
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

- [ ] **Step 5: Failing tests**

`backend/tests/test_models.py`:

```python
from datetime import datetime, timezone

import pytest
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError

from app.db import get_sessionmaker
from app.models import Installation, Issue, Repository

TS = datetime(2026, 7, 1, tzinfo=timezone.utc)


def make_issue(**overrides) -> Issue:
    defaults = dict(
        id=1001,
        repository_id=500,
        number=1,
        title="First issue",
        state="open",
        gh_created_at=TS,
        gh_updated_at=TS,
        labels=[{"name": "bug", "color": "d73a4a"}],
        assignees=["patelmj"],
    )
    defaults.update(overrides)
    return Issue(**defaults)


async def seed_repo(session) -> None:
    session.add(Installation(id=99, account_login="patelmj"))
    session.add(
        Repository(
            id=500, installation_id=99, full_name="patelmj/IssueLens",
            owner="patelmj", name="IssueLens",
        )
    )
    await session.commit()


async def test_round_trip_issue(clean_db):
    async with get_sessionmaker()() as session:
        await seed_repo(session)
        session.add(make_issue())
        await session.commit()
        row = (await session.execute(select(Issue))).scalar_one()
        assert row.labels == [{"name": "bug", "color": "d73a4a"}]
        assert row.assignees == ["patelmj"]


async def test_repo_number_unique(clean_db):
    async with get_sessionmaker()() as session:
        await seed_repo(session)
        session.add(make_issue())
        await session.commit()
        session.add(make_issue(id=1002, number=1))
        with pytest.raises(IntegrityError):
            await session.commit()


async def test_delete_repo_cascades_issues(clean_db):
    async with get_sessionmaker()() as session:
        await seed_repo(session)
        session.add(make_issue())
        await session.commit()
        repo = (await session.execute(select(Repository))).scalar_one()
        await session.delete(repo)
        await session.commit()
        assert (await session.execute(select(Issue))).scalar_one_or_none() is None
```

Run: `docker compose up -d postgres && cd backend && uv run pytest tests/test_models.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'app.models'`.

- [ ] **Step 6: Migrate and pass**

Run: `uv run alembic upgrade head` — expected `Running upgrade 0001 -> 0002`.
Run: `uv run pytest -v` — all pass (existing + 3 new).
Run: `uv run ruff check .` — clean.

- [ ] **Step 7: Commit**

```bash
git add backend/app/models.py backend/app/db.py backend/alembic/versions/0002_github_sync_tables.py backend/tests/
git commit -m "feat(backend): sync data model, migration 0002, session factory"
```

---

### Task 3: GitHub auth + client

**Files:**
- Create: `backend/app/github/__init__.py` (empty), `backend/app/github/auth.py`, `backend/app/github/client.py`, `backend/tests/test_github_auth.py`, `backend/tests/test_github_client.py`

**Interfaces:**
- Consumes: `get_settings()` (Task 1 fields).
- Produces: `auth.GitHubAppNotConfigured` (exception), `auth.make_app_jwt() -> str`, `auth.get_installation_token(installation_id, client) -> str` (cached ~55 min), `auth.clear_token_cache()`, `auth.GITHUB_API = "https://api.github.com"`; `client.make_http_client() -> httpx.AsyncClient`, `client.GitHubRateLimited` (has `.reset_epoch`), `client.app_get(client, path)`, `client.installation_get_paginated(client, installation_id, path, params=None, items_key=None) -> list[dict]`.

- [ ] **Step 1: Failing tests**

`backend/tests/test_github_auth.py`:

```python
import base64

import httpx
import jwt
import pytest
import respx
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa

from app.config import get_settings
from app.github.auth import (
    GitHubAppNotConfigured,
    clear_token_cache,
    get_installation_token,
    make_app_jwt,
)
from app.github.client import make_http_client


@pytest.fixture
def app_creds(monkeypatch):
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    pem = key.private_bytes(
        serialization.Encoding.PEM,
        serialization.PrivateFormat.PKCS8,
        serialization.NoEncryption(),
    )
    monkeypatch.setenv("ISSUELENS_GITHUB_APP_ID", "12345")
    monkeypatch.setenv(
        "ISSUELENS_GITHUB_APP_PRIVATE_KEY_B64", base64.b64encode(pem).decode()
    )
    get_settings.cache_clear()
    clear_token_cache()
    yield key
    get_settings.cache_clear()
    clear_token_cache()


def test_jwt_raises_when_unconfigured():
    with pytest.raises(GitHubAppNotConfigured):
        make_app_jwt()


def test_jwt_claims(app_creds):
    token = make_app_jwt()
    public_pem = app_creds.public_key().public_bytes(
        serialization.Encoding.PEM, serialization.PublicFormat.SubjectPublicKeyInfo
    )
    claims = jwt.decode(token, public_pem, algorithms=["RS256"])
    assert claims["iss"] == "12345"
    assert claims["exp"] > claims["iat"]


@respx.mock
async def test_installation_token_cached(app_creds):
    route = respx.post(
        "https://api.github.com/app/installations/42/access_tokens"
    ).mock(
        return_value=httpx.Response(
            201, json={"token": "ghs_test", "expires_at": "2099-01-01T00:00:00Z"}
        )
    )
    async with make_http_client() as client:
        t1 = await get_installation_token(42, client)
        t2 = await get_installation_token(42, client)
    assert t1 == t2 == "ghs_test"
    assert route.call_count == 1
```

`backend/tests/test_github_client.py`:

```python
import httpx
import pytest
import respx

from app.github.client import (
    GitHubRateLimited,
    installation_get_paginated,
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
async def test_pagination_follows_link_header(app_creds):  # noqa: F811
    _token_route()
    page2_url = "https://api.github.com/repos/o/r/issues?page=2"
    respx.get("https://api.github.com/repos/o/r/issues").mock(
        return_value=httpx.Response(
            200, json=[{"n": 1}], headers={"Link": f'<{page2_url}>; rel="next"'}
        )
    )
    respx.get(page2_url).mock(return_value=httpx.Response(200, json=[{"n": 2}]))
    async with make_http_client() as client:
        items = await installation_get_paginated(client, 42, "/repos/o/r/issues")
    assert [i["n"] for i in items] == [1, 2]


@respx.mock
async def test_rate_limit_raises_with_reset(app_creds):  # noqa: F811
    _token_route()
    respx.get("https://api.github.com/repos/o/r/issues").mock(
        return_value=httpx.Response(
            403,
            json={"message": "rate limited"},
            headers={"x-ratelimit-remaining": "0", "x-ratelimit-reset": "1790000000"},
        )
    )
    async with make_http_client() as client:
        with pytest.raises(GitHubRateLimited) as exc:
            await installation_get_paginated(client, 42, "/repos/o/r/issues")
    assert exc.value.reset_epoch == 1790000000
```

Run: `uv run pytest tests/test_github_auth.py tests/test_github_client.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'app.github'`.

- [ ] **Step 2: Implement auth**

Create empty `backend/app/github/__init__.py`. `backend/app/github/auth.py`:

```python
import base64
import time

import httpx
import jwt

from app.config import get_settings

GITHUB_API = "https://api.github.com"

_token_cache: dict[int, tuple[str, float]] = {}


class GitHubAppNotConfigured(Exception):
    def __init__(self) -> None:
        super().__init__("GitHub App not configured - see README ('GitHub App setup')")


def _private_key_pem() -> str:
    settings = get_settings()
    if not settings.github_app_id or not settings.github_app_private_key_b64:
        raise GitHubAppNotConfigured()
    return base64.b64decode(settings.github_app_private_key_b64).decode()


def make_app_jwt() -> str:
    pem = _private_key_pem()
    now = int(time.time())
    payload = {"iat": now - 60, "exp": now + 540, "iss": get_settings().github_app_id}
    return jwt.encode(payload, pem, algorithm="RS256")


async def get_installation_token(installation_id: int, client: httpx.AsyncClient) -> str:
    cached = _token_cache.get(installation_id)
    if cached and cached[1] - time.time() > 300:
        return cached[0]
    resp = await client.post(
        f"/app/installations/{installation_id}/access_tokens",
        headers={"Authorization": f"Bearer {make_app_jwt()}"},
    )
    resp.raise_for_status()
    token = resp.json()["token"]
    _token_cache[installation_id] = (token, time.time() + 55 * 60)
    return token


def clear_token_cache() -> None:
    _token_cache.clear()
```

- [ ] **Step 3: Implement client**

`backend/app/github/client.py`:

```python
from typing import Any

import httpx

from app.github.auth import GITHUB_API, get_installation_token, make_app_jwt


class GitHubRateLimited(Exception):
    def __init__(self, reset_epoch: int) -> None:
        self.reset_epoch = reset_epoch
        super().__init__(f"GitHub rate limit exceeded; resets at epoch {reset_epoch}")


def make_http_client() -> httpx.AsyncClient:
    return httpx.AsyncClient(
        base_url=GITHUB_API,
        headers={
            "Accept": "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
        },
        timeout=30.0,
    )


def _check_rate_limit(resp: httpx.Response) -> None:
    if resp.status_code == 403 and resp.headers.get("x-ratelimit-remaining") == "0":
        raise GitHubRateLimited(int(resp.headers.get("x-ratelimit-reset", "0")))


async def app_get(client: httpx.AsyncClient, path: str) -> Any:
    resp = await client.get(path, headers={"Authorization": f"Bearer {make_app_jwt()}"})
    _check_rate_limit(resp)
    resp.raise_for_status()
    return resp.json()


async def installation_get_paginated(
    client: httpx.AsyncClient,
    installation_id: int,
    path: str,
    params: dict[str, Any] | None = None,
    items_key: str | None = None,
) -> list[dict[str, Any]]:
    token = await get_installation_token(installation_id, client)
    headers = {"Authorization": f"Bearer {token}"}
    items: list[dict[str, Any]] = []
    url: str = path
    first = True
    while url:
        resp = await client.get(
            url,
            params={"per_page": 100, **(params or {})} if first else None,
            headers=headers,
        )
        _check_rate_limit(resp)
        resp.raise_for_status()
        data = resp.json()
        items.extend(data[items_key] if items_key else data)
        url = resp.links.get("next", {}).get("url", "")
        first = False
    return items
```

- [ ] **Step 4: Pass, lint, commit**

Run: `uv run pytest -v` (all pass) and `uv run ruff check .` (clean).

```bash
git add backend/app/github/ backend/tests/test_github_auth.py backend/tests/test_github_client.py
git commit -m "feat(backend): github app auth and thin rest client"
```

---

### Task 4: Discovery + sync logic

**Files:**
- Create: `backend/app/github/sync.py`, `backend/tests/test_sync.py`

**Interfaces:**
- Consumes: models (Task 2), client/auth (Task 3), `get_sessionmaker` (Task 2).
- Produces: `sync.refresh_installations(session, client) -> int` (repo count; prunes rows no longer accessible); `sync.sync_repository_issues(session, client, repo_id, full=False) -> int` (issues upserted; manages `sync_status`, `sync_jobs`, cursor, `open_issues_count`); `sync.SINCE_OVERLAP = timedelta(minutes=5)`.

- [ ] **Step 1: Failing tests**

`backend/tests/test_sync.py`:

```python
from datetime import datetime, timezone

import httpx
import pytest
import respx
from sqlalchemy import select

from app.db import get_sessionmaker
from app.github.client import make_http_client
from app.github.sync import refresh_installations, sync_repository_issues
from app.models import Installation, Issue, Repository, SyncJob
from tests.test_github_auth import app_creds  # noqa: F401 - reused fixture


def _token_route():
    respx.post("https://api.github.com/app/installations/42/access_tokens").mock(
        return_value=httpx.Response(
            201, json={"token": "ghs_test", "expires_at": "2099-01-01T00:00:00Z"}
        )
    )


def gh_issue(id_: int, number: int, state: str = "open", pr: bool = False, updated: str = "2026-07-10T10:00:00Z") -> dict:
    item = {
        "id": id_,
        "number": number,
        "title": f"Issue {number}",
        "body": "body text",
        "state": state,
        "user": {"login": "patelmj"},
        "labels": [{"name": "bug", "color": "d73a4a"}],
        "assignees": [{"login": "patelmj"}],
        "milestone": None,
        "comments": 2,
        "created_at": "2026-07-01T00:00:00Z",
        "updated_at": updated,
        "closed_at": None,
    }
    if pr:
        item["pull_request"] = {"url": "https://api.github.com/..."}
    return item


async def seed(session) -> None:
    session.add(Installation(id=42, account_login="patelmj"))
    session.add(
        Repository(
            id=500, installation_id=42, full_name="patelmj/IssueLens",
            owner="patelmj", name="IssueLens",
        )
    )
    await session.commit()


@respx.mock
async def test_refresh_upserts_and_prunes(app_creds, clean_db):  # noqa: F811
    _token_route()
    respx.get("https://api.github.com/app/installations").mock(
        return_value=httpx.Response(
            200, json=[{"id": 42, "account": {"login": "patelmj"}}]
        )
    )
    respx.get("https://api.github.com/installation/repositories").mock(
        return_value=httpx.Response(
            200,
            json={
                "repositories": [
                    {
                        "id": 500,
                        "full_name": "patelmj/IssueLens",
                        "name": "IssueLens",
                        "private": True,
                        "owner": {"login": "patelmj"},
                    }
                ]
            },
        )
    )
    async with get_sessionmaker()() as session:
        # pre-seed a stale repo that GitHub no longer reports
        session.add(Installation(id=42, account_login="old"))
        session.add(
            Repository(id=999, installation_id=42, full_name="patelmj/gone",
                       owner="patelmj", name="gone")
        )
        await session.commit()
        async with make_http_client() as client:
            count = await refresh_installations(session, client)
        assert count == 1
        repos = list((await session.execute(select(Repository))).scalars())
        assert [r.id for r in repos] == [500]
        assert repos[0].private is True


@respx.mock
async def test_sync_idempotent_and_pr_flagging(app_creds, clean_db):  # noqa: F811
    _token_route()
    payload = [gh_issue(1, 1), gh_issue(2, 2, state="closed"), gh_issue(3, 3, pr=True)]
    respx.get("https://api.github.com/repos/patelmj/IssueLens/issues").mock(
        return_value=httpx.Response(200, json=payload)
    )
    async with get_sessionmaker()() as session:
        await seed(session)
        async with make_http_client() as client:
            n1 = await sync_repository_issues(session, client, 500)
            n2 = await sync_repository_issues(session, client, 500)
        assert n1 == 3 and n2 == 3
        issues = list((await session.execute(select(Issue))).scalars())
        assert len(issues) == 3  # idempotent - no duplicates
        assert sum(1 for i in issues if i.is_pull_request) == 1
        repo = (await session.execute(select(Repository))).scalar_one()
        assert repo.open_issues_count == 1  # open, non-PR only
        assert repo.sync_status == "idle"
        assert repo.last_synced_at == datetime(2026, 7, 10, 10, 0, tzinfo=timezone.utc)
        jobs = list((await session.execute(select(SyncJob))).scalars())
        assert [j.status for j in jobs] == ["success", "success"]


@respx.mock
async def test_sync_error_path(app_creds, clean_db):  # noqa: F811
    _token_route()
    respx.get("https://api.github.com/repos/patelmj/IssueLens/issues").mock(
        return_value=httpx.Response(500, json={"message": "boom"})
    )
    async with get_sessionmaker()() as session:
        await seed(session)
        async with make_http_client() as client:
            with pytest.raises(httpx.HTTPStatusError):
                await sync_repository_issues(session, client, 500)
        repo = (await session.execute(select(Repository))).scalar_one()
        assert repo.sync_status == "error"
        assert repo.sync_error
        job = (await session.execute(select(SyncJob))).scalar_one()
        assert job.status == "error"
```

Run: `uv run pytest tests/test_sync.py -v` — expected FAIL: no module `app.github.sync`.

- [ ] **Step 2: Implement sync.py**

`backend/app/github/sync.py`:

```python
from datetime import datetime, timedelta
from typing import Any

import httpx
from sqlalchemy import delete, func, select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.github.client import app_get, installation_get_paginated
from app.models import Installation, Issue, Repository, SyncJob

SINCE_OVERLAP = timedelta(minutes=5)


def _parse_ts(value: str | None) -> datetime | None:
    if not value:
        return None
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


async def refresh_installations(session: AsyncSession, client: httpx.AsyncClient) -> int:
    installations = await app_get(client, "/app/installations")
    seen_inst_ids: list[int] = []
    seen_repo_ids: list[int] = []
    for inst in installations:
        seen_inst_ids.append(inst["id"])
        await session.execute(
            pg_insert(Installation)
            .values(id=inst["id"], account_login=inst["account"]["login"])
            .on_conflict_do_update(
                index_elements=["id"],
                set_={"account_login": inst["account"]["login"], "updated_at": func.now()},
            )
        )
        repos = await installation_get_paginated(
            client, inst["id"], "/installation/repositories", items_key="repositories"
        )
        for repo in repos:
            seen_repo_ids.append(repo["id"])
            await session.execute(
                pg_insert(Repository)
                .values(
                    id=repo["id"],
                    installation_id=inst["id"],
                    full_name=repo["full_name"],
                    owner=repo["owner"]["login"],
                    name=repo["name"],
                    private=repo["private"],
                )
                .on_conflict_do_update(
                    index_elements=["id"],
                    set_={
                        "installation_id": inst["id"],
                        "full_name": repo["full_name"],
                        "owner": repo["owner"]["login"],
                        "name": repo["name"],
                        "private": repo["private"],
                    },
                )
            )
    await session.execute(delete(Repository).where(Repository.id.not_in(seen_repo_ids)))
    await session.execute(delete(Installation).where(Installation.id.not_in(seen_inst_ids)))
    await session.commit()
    return len(seen_repo_ids)


def _issue_values(item: dict[str, Any], repo_id: int) -> dict[str, Any]:
    return {
        "id": item["id"],
        "repository_id": repo_id,
        "number": item["number"],
        "title": item["title"],
        "body": item.get("body"),
        "state": item["state"],
        "author_login": (item.get("user") or {}).get("login", ""),
        "labels": [
            {"name": lb["name"], "color": lb.get("color") or ""}
            for lb in item.get("labels", [])
        ],
        "assignees": [a["login"] for a in item.get("assignees", [])],
        "milestone_title": (item.get("milestone") or {}).get("title"),
        "comments_count": item.get("comments", 0),
        "is_pull_request": "pull_request" in item,
        "gh_created_at": _parse_ts(item["created_at"]),
        "gh_updated_at": _parse_ts(item["updated_at"]),
        "gh_closed_at": _parse_ts(item.get("closed_at")),
        "synced_at": func.now(),
    }


async def sync_repository_issues(
    session: AsyncSession, client: httpx.AsyncClient, repo_id: int, full: bool = False
) -> int:
    repo = (
        await session.execute(select(Repository).where(Repository.id == repo_id))
    ).scalar_one()
    job = SyncJob(
        repository_id=repo_id, kind="full" if full else "incremental", status="running"
    )
    session.add(job)
    repo.sync_status = "syncing"
    repo.sync_error = None
    await session.commit()
    job_id = job.id
    try:
        params: dict[str, Any] = {"state": "all", "sort": "updated", "direction": "asc"}
        if repo.last_synced_at and not full:
            since = repo.last_synced_at - SINCE_OVERLAP
            params["since"] = since.strftime("%Y-%m-%dT%H:%M:%SZ")
        raw_issues = await installation_get_paginated(
            client, repo.installation_id, f"/repos/{repo.full_name}/issues", params=params
        )
        max_updated = repo.last_synced_at
        for item in raw_issues:
            values = _issue_values(item, repo_id)
            update_cols = {k: v for k, v in values.items() if k != "id"}
            await session.execute(
                pg_insert(Issue)
                .values(**values)
                .on_conflict_do_update(index_elements=["id"], set_=update_cols)
            )
            gh_updated = _parse_ts(item["updated_at"])
            if max_updated is None or (gh_updated and gh_updated > max_updated):
                max_updated = gh_updated
        open_count = (
            await session.execute(
                select(func.count())
                .select_from(Issue)
                .where(
                    Issue.repository_id == repo_id,
                    Issue.state == "open",
                    Issue.is_pull_request.is_(False),
                )
            )
        ).scalar_one()
        repo.open_issues_count = open_count
        repo.last_synced_at = max_updated
        repo.sync_status = "idle"
        job.status = "success"
        job.issues_upserted = len(raw_issues)
        job.finished_at = func.now()
        await session.commit()
        return len(raw_issues)
    except Exception as exc:
        await session.rollback()
        repo = (
            await session.execute(select(Repository).where(Repository.id == repo_id))
        ).scalar_one()
        job = (
            await session.execute(select(SyncJob).where(SyncJob.id == job_id))
        ).scalar_one()
        repo.sync_status = "error"
        repo.sync_error = str(exc)[:500]
        job.status = "error"
        job.error = str(exc)[:500]
        job.finished_at = func.now()
        await session.commit()
        raise
```

- [ ] **Step 3: Pass, lint, commit**

Run: `uv run pytest -v` (all pass) and `uv run ruff check .` (clean).

```bash
git add backend/app/github/sync.py backend/tests/test_sync.py
git commit -m "feat(backend): installation discovery and idempotent issue sync"
```

---

### Task 5: Worker jobs + reconciliation cron + queue helper

**Files:**
- Create: `backend/app/queue.py`, `backend/tests/test_worker_jobs.py`
- Modify: `backend/worker.py`

**Interfaces:**
- Consumes: `sync_repository_issues`, `get_sessionmaker`, `make_http_client`.
- Produces: worker job `sync_repository(ctx, repo_id, full=False)` registered in `WorkerSettings.functions`; cron `reconcile_all_repositories` every 30 min; `app.queue.get_arq_pool()` (module-level cached ARQ pool used by the API).

- [ ] **Step 1: Failing test**

`backend/tests/test_worker_jobs.py`:

```python
import worker


def test_sync_job_registered():
    names = [f.__name__ for f in worker.WorkerSettings.functions]
    assert "ping" in names
    assert "sync_repository" in names


def test_reconcile_cron_registered():
    assert len(worker.WorkerSettings.cron_jobs) == 1
    assert worker.WorkerSettings.cron_jobs[0].name == "reconcile_all_repositories"
```

Run: `uv run pytest tests/test_worker_jobs.py -v` — FAIL (no `sync_repository`, no `cron_jobs`).

- [ ] **Step 2: Implement queue helper**

`backend/app/queue.py`:

```python
from arq import create_pool
from arq.connections import ArqRedis, RedisSettings

from app.config import get_settings

_pool: ArqRedis | None = None


async def get_arq_pool() -> ArqRedis:
    global _pool
    if _pool is None:
        _pool = await create_pool(RedisSettings.from_dsn(get_settings().redis_url))
    return _pool
```

- [ ] **Step 3: Extend worker.py (full replacement)**

`backend/worker.py`:

```python
import logging

from arq import cron
from arq.connections import RedisSettings

from app.config import get_settings
from app.db import get_sessionmaker
from app.github.client import make_http_client
from app.github.sync import sync_repository_issues

logger = logging.getLogger(__name__)


async def ping(ctx: dict) -> str:
    return "pong"


async def sync_repository(ctx: dict, repo_id: int, full: bool = False) -> int:
    async with get_sessionmaker()() as session, make_http_client() as client:
        return await sync_repository_issues(session, client, repo_id, full=full)


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


class WorkerSettings:
    functions = [ping, sync_repository]
    cron_jobs = [cron(reconcile_all_repositories, minute={0, 30})]
    redis_settings = RedisSettings.from_dsn(get_settings().redis_url)
```

- [ ] **Step 4: Pass, verify container, commit**

Run: `uv run pytest -v` (all pass — including the existing ping round-trip; rebuild the worker first: `docker compose up -d --build worker`) and `uv run ruff check .`.
Check `docker compose logs worker --tail 20` shows both functions and the cron registered.

```bash
git add backend/worker.py backend/app/queue.py backend/tests/test_worker_jobs.py
git commit -m "feat(backend): sync worker job, reconciliation cron, arq pool helper"
```

---

### Task 6: Repositories API router

**Files:**
- Create: `backend/app/routers/__init__.py` (empty), `backend/app/routers/repositories.py`, `backend/tests/test_api_repositories.py`
- Modify: `backend/app/main.py`

**Interfaces:**
- Consumes: models, `get_session`, `refresh_installations`, `make_http_client`, `get_arq_pool`, settings.
- Produces: `GET /repositories` → 200 `list[RepositoryOut]` (DB-only; works unconfigured); `POST /repositories/refresh` → 200 list (503 `{"detail": ...}` if App unconfigured); `POST /repositories/{repo_id}/sync?full=` → 202 `{"queued": true}` (404 unknown repo, 503 unconfigured). `RepositoryOut` fields: `id, full_name, private, open_issues_count, last_synced_at, sync_status, sync_error`.

- [ ] **Step 1: Failing tests**

`backend/tests/test_api_repositories.py`:

```python
import httpx
import pytest
import respx
from httpx import ASGITransport, AsyncClient

from app.db import get_sessionmaker
from app.main import app
from app.models import Installation, Repository
from tests.test_github_auth import app_creds  # noqa: F401 - reused fixture


@pytest.fixture
def api():
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test")


async def seed_repo():
    async with get_sessionmaker()() as session:
        session.add(Installation(id=42, account_login="patelmj"))
        session.add(
            Repository(id=500, installation_id=42, full_name="patelmj/IssueLens",
                       owner="patelmj", name="IssueLens")
        )
        await session.commit()


async def test_list_empty(clean_db, api):
    async with api as client:
        resp = await client.get("/repositories")
    assert resp.status_code == 200
    assert resp.json() == []


async def test_list_returns_seeded(clean_db, api):
    await seed_repo()
    async with api as client:
        resp = await client.get("/repositories")
    body = resp.json()
    assert len(body) == 1
    assert body[0]["full_name"] == "patelmj/IssueLens"
    assert body[0]["sync_status"] == "idle"


async def test_refresh_unconfigured_returns_503(clean_db, api):
    async with api as client:
        resp = await client.post("/repositories/refresh")
    assert resp.status_code == 503
    assert "GitHub App not configured" in resp.json()["detail"]


@respx.mock
async def test_refresh_configured(app_creds, clean_db, api):  # noqa: F811
    respx.get("https://api.github.com/app/installations").mock(
        return_value=httpx.Response(200, json=[])
    )
    async with api as client:
        resp = await client.post("/repositories/refresh")
    assert resp.status_code == 200
    assert resp.json() == []


async def test_sync_unknown_repo_404(app_creds, clean_db, api):  # noqa: F811
    async with api as client:
        resp = await client.post("/repositories/12345/sync")
    assert resp.status_code == 404


async def test_sync_enqueues(app_creds, clean_db, api, monkeypatch):  # noqa: F811
    await seed_repo()
    calls: list[tuple] = []

    class FakePool:
        async def enqueue_job(self, name, *args):
            calls.append((name, args))

    async def fake_pool():
        return FakePool()

    monkeypatch.setattr("app.routers.repositories.get_arq_pool", fake_pool)
    async with api as client:
        resp = await client.post("/repositories/500/sync?full=true")
    assert resp.status_code == 202
    assert resp.json() == {"queued": True}
    assert calls == [("sync_repository", (500, True))]
```

Run: `uv run pytest tests/test_api_repositories.py -v` — FAIL: no module `app.routers.repositories`.

- [ ] **Step 2: Implement router**

Create empty `backend/app/routers/__init__.py`. `backend/app/routers/repositories.py`:

```python
from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import get_settings
from app.db import get_session
from app.github.auth import GitHubAppNotConfigured
from app.github.client import make_http_client
from app.github.sync import refresh_installations
from app.models import Repository
from app.queue import get_arq_pool

router = APIRouter(prefix="/repositories", tags=["repositories"])


class RepositoryOut(BaseModel):
    id: int
    full_name: str
    private: bool
    open_issues_count: int
    last_synced_at: datetime | None
    sync_status: str
    sync_error: str | None

    model_config = {"from_attributes": True}


def _require_app_config() -> None:
    settings = get_settings()
    if not settings.github_app_id or not settings.github_app_private_key_b64:
        raise HTTPException(
            status_code=503,
            detail="GitHub App not configured - see README ('GitHub App setup')",
        )


async def _list_repos(session: AsyncSession) -> list[Repository]:
    result = await session.execute(select(Repository).order_by(Repository.full_name))
    return list(result.scalars())


@router.get("", response_model=list[RepositoryOut])
async def list_repositories(
    session: AsyncSession = Depends(get_session),
) -> list[Repository]:
    return await _list_repos(session)


@router.post("/refresh", response_model=list[RepositoryOut])
async def refresh_repositories(
    session: AsyncSession = Depends(get_session),
) -> list[Repository]:
    _require_app_config()
    try:
        async with make_http_client() as client:
            await refresh_installations(session, client)
    except GitHubAppNotConfigured as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    return await _list_repos(session)


@router.post("/{repo_id}/sync", status_code=202)
async def trigger_sync(
    repo_id: int, full: bool = False, session: AsyncSession = Depends(get_session)
) -> dict:
    _require_app_config()
    repo = (
        await session.execute(select(Repository).where(Repository.id == repo_id))
    ).scalar_one_or_none()
    if repo is None:
        raise HTTPException(status_code=404, detail="Repository not found")
    pool = await get_arq_pool()
    await pool.enqueue_job("sync_repository", repo_id, full)
    return {"queued": True}
```

In `backend/app/main.py`, add after the app is created:

```python
from app.routers.repositories import router as repositories_router

app.include_router(repositories_router)
```

(Place the import at the top of the file with the other imports.)

- [ ] **Step 3: Pass, lint, commit**

Run: `uv run pytest -v` (all pass) and `uv run ruff check .` (clean).

```bash
git add backend/app/routers/ backend/app/main.py backend/tests/test_api_repositories.py
git commit -m "feat(backend): repositories api - list, refresh, sync"
```

---

### Task 7: Frontend Repositories page

**Files:**
- Create: `frontend/src/app/repositories/repositories-client.tsx`
- Modify: `frontend/src/app/repositories/page.tsx` (full replacement), `frontend/src/app/globals.css` (add danger tokens)

**Interfaces:**
- Consumes: proxy `/api/backend/repositories*` (Task 6 shapes), tokens, TanStack Query provider.
- Produces: live `/repositories` page; new tokens `--color-danger: #d1242f` (light) / `#f47067` (dark). Content region carries `data-testid="repositories-content"` (Task 8 asserts it).

- [ ] **Step 1: Add danger tokens**

In `frontend/src/app/globals.css`, add inside `:root {` after `--shadow-card...`:

```css
  --color-danger: #d1242f;
```

and inside `:root[data-mode="dark"] {` after `--flash...`:

```css
  --color-danger: #f47067;
```

- [ ] **Step 2: Write the client component**

`frontend/src/app/repositories/repositories-client.tsx`:

```tsx
"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

type Repo = {
  id: number;
  full_name: string;
  private: boolean;
  open_issues_count: number;
  last_synced_at: string | null;
  sync_status: "idle" | "syncing" | "error";
  sync_error: string | null;
};

async function getJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { detail?: string } | null;
    throw new Error(body?.detail ?? `Request failed (${res.status})`);
  }
  return res.json() as Promise<T>;
}

function relativeTime(iso: string | null): string {
  if (!iso) return "never";
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

const STATUS_DOT: Record<Repo["sync_status"], string> = {
  idle: "bg-(--color-text-muted)",
  syncing: "bg-(--color-primary)",
  error: "bg-(--color-danger)",
};

const card =
  "rounded-[14px] border border-(--color-border) bg-(--color-surface) shadow-(--shadow-card)";
const btn =
  "rounded-lg border border-(--color-border) bg-(--color-surface) px-2.5 py-1.5 text-(--color-primary) transition-all duration-150 hover:bg-(--accent-tint) disabled:text-(--color-text-muted) disabled:hover:bg-(--color-surface)";

export function RepositoriesClient() {
  const queryClient = useQueryClient();
  const { data: repos, error, isPending } = useQuery({
    queryKey: ["repositories"],
    queryFn: () => getJson<Repo[]>("/api/backend/repositories"),
    refetchInterval: (query) =>
      query.state.data?.some((r) => r.sync_status === "syncing") ? 3000 : false,
  });
  const refresh = useMutation({
    mutationFn: () =>
      getJson<Repo[]>("/api/backend/repositories/refresh", { method: "POST" }),
    onSuccess: (data) => queryClient.setQueryData(["repositories"], data),
  });
  const sync = useMutation({
    mutationFn: (id: number) =>
      getJson<{ queued: boolean }>(`/api/backend/repositories/${id}/sync`, {
        method: "POST",
      }),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: ["repositories"] }),
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
            <li key={repo.id} className={`${card} flex items-center gap-3 px-4 py-3`}>
              <span
                className={`inline-block h-2 w-2 rounded-full ${STATUS_DOT[repo.sync_status]}`}
                title={`Sync status: ${repo.sync_status}`}
              />
              <span className="font-medium">{repo.full_name}</span>
              {repo.private ? (
                <span className="rounded-full border border-(--color-border) px-1.5 text-[10px] text-(--color-text-muted)">
                  private
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

- [ ] **Step 3: Replace the page**

`frontend/src/app/repositories/page.tsx` (full replacement):

```tsx
import { RepositoriesClient } from "./repositories-client";

export default function RepositoriesPage() {
  return <RepositoriesClient />;
}
```

- [ ] **Step 4: Verify and commit**

Run: `cd frontend && npm run lint && npm run build` — clean; route list unchanged (7 routes).

```bash
git add frontend/src/app/globals.css frontend/src/app/repositories/ 
git commit -m "feat(frontend): live repositories page with sync controls"
```

---

### Task 8: Playwright, README, push

**Files:**
- Create: `frontend/e2e/repositories.spec.ts`
- Modify: `README.md`

**Interfaces:**
- Consumes: everything above.
- Produces: e2e coverage of the Repositories page's h1 + content region; README "GitHub App setup" section; branch pushed with CI green. Do NOT open a PR; do NOT mark board items done.

- [ ] **Step 1: Playwright test**

`frontend/e2e/repositories.spec.ts`:

```ts
import { expect, test } from "@playwright/test";

test("repositories page renders its content region", async ({ page }) => {
  await page.goto("/repositories");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Repositories");
  await expect(page.getByTestId("repositories-content")).toBeVisible();
});
```

(The content region renders in every state — loading, backend-down error card, empty setup state, and rows — so this test is valid with or without the backend running.)

Run: `cd frontend && npm run test:e2e` — 4 passed (3 existing + 1 new). Port 3005 is IssueLens-only; no container juggling needed.

- [ ] **Step 2: README — GitHub App setup section**

Add to `README.md` after the "Quickstart" section:

````markdown
## GitHub App setup (one-time)

IssueLens authenticates as a GitHub App (no PATs). ~5 minutes:

1. GitHub → Settings → Developer settings → GitHub Apps → **New GitHub App**
2. Name: `issuelens-local` (any unique name). Homepage URL: `http://localhost:3005`
3. **Webhook: uncheck "Active"** (polling only for now)
4. Permissions → Repository: **Issues: Read-only**, **Metadata: Read-only**
5. Create the app, note the **App ID**, then **Generate a private key** (.pem downloads)
6. Install the App on the repositories you want to sync
7. In repo-root `.env` (never committed):

   ```sh
   ISSUELENS_GITHUB_APP_ID=<your app id>
   ISSUELENS_GITHUB_APP_PRIVATE_KEY_B64=<base64 of the .pem file contents>
   ```

   PowerShell: `[Convert]::ToBase64String([IO.File]::ReadAllBytes("path\to\key.pem"))`
8. `docker compose up -d --build backend worker`, open http://localhost:3005/repositories,
   click **Refresh from GitHub**, then **Sync** on a repo. Issues land in Postgres;
   a reconciliation job re-syncs every 30 minutes.
````

- [ ] **Step 3: Full verification, commit, push**

Run: `docker compose up -d postgres redis && cd backend && uv run alembic upgrade head && uv run pytest -v` — all pass.
Run: `cd frontend && npm run lint && npm run build && npm run test:e2e` — clean, 4 passed.

```bash
git add frontend/e2e/repositories.spec.ts README.md
git commit -m "test: repositories page e2e; docs: github app setup"
git push -u origin feat/github-sync
```

Watch CI: `gh run list --branch feat/github-sync --limit 1` then `gh run watch <id> --exit-status` — both jobs green.

Then STOP: surface a summary and wait for the merge decision. Board #3 stays In Progress until merged.

---

## Final verification (whole slice)

- [ ] Backend suite green (needs postgres+redis up, migrations at head, worker rebuilt).
- [ ] `npm run lint && npm run build && npm run test:e2e` green.
- [ ] CI green on `feat/github-sync`.
- [ ] Live dogfood (requires the user's one-time GitHub App registration): Refresh from GitHub lists `patelmj/IssueLens`; Sync pulls its real issues; `SELECT count(*) FROM issues` > 0; re-sync doesn't duplicate.
