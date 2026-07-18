# IssueLens Foundation Slice Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up the full IssueLens stack (Next.js + FastAPI + Postgres/pgvector + Redis/ARQ in Docker Compose) and ship a themed, navigable, empty dashboard shell.

**Architecture:** `frontend/` (Next.js App Router, Tailwind v4, TanStack Query) talks to `backend/` (FastAPI, async SQLAlchemy, Alembic, ARQ worker) through a Next.js route-handler proxy; Postgres 17 with pgvector and Redis 7 run as compose services with healthchecks gating startup order. Theming is CSS custom-property tokens switched by a `data-mode` attribute, dark default.

**Tech Stack:** Python 3.12 + uv, FastAPI, SQLAlchemy 2 async + asyncpg, Alembic, ARQ, pydantic-settings, pytest (+pytest-asyncio auto mode), Next.js 16 (TypeScript, App Router, src dir), Tailwind CSS v4, TanStack Query v5, Playwright, Docker Compose, GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-07-18-issuelens-foundation-design.md` · Board issues [#1](https://github.com/patelmj/IssueLens/issues/1), [#2](https://github.com/patelmj/IssueLens/issues/2)

## Global Constraints

- Work on branch `feat/foundation`. Never commit to `main`. No AI attribution / `Co-Authored-By` lines in commit messages (house rule).
- All env vars are prefixed `ISSUELENS_`. When a compose env var is added/changed, `.env.example` is updated **in the same commit**.
- **No hardcoded colors in frontend code** — every color goes through a CSS custom-property token. Tailwind v4 arbitrary-property syntax is `bg-(--color-bg)` with parentheses; `bg-[--color-bg]` (brackets) silently produces empty CSS and is forbidden.
- Dark mode is the default (`data-mode="dark"`). Accent is indigo, never GitHub blue. Active states use accent-tint washes, never solid accent fills.
- Inactive/placeholder UI elements stay visible but muted — never hidden.
- UI verification is Playwright CLI only, no manual-browser-only claims.
- Backend tests pin behavior-affecting env vars explicitly in fixtures (never inherit silently from the host).
- Local test runs assume `docker compose up -d postgres redis` (and `worker` for Task 4's round-trip test); each task's steps say what must be running.

---

### Task 1: Backend skeleton — FastAPI app, settings, /healthz

**Files:**
- Create: `.gitignore`, `backend/pyproject.toml`, `backend/app/__init__.py`, `backend/app/config.py`, `backend/app/main.py`, `backend/tests/__init__.py`, `backend/tests/conftest.py`, `backend/tests/test_health.py`, `backend/tests/test_config.py`

**Interfaces:**
- Consumes: nothing (first task).
- Produces: `app.config.get_settings() -> Settings` (`@lru_cache`; fields `database_url: str`, `redis_url: str`, env prefix `ISSUELENS_`); FastAPI instance `app.main.app`; `GET /healthz -> {"status": "ok"}` (Task 3 adds a `"database"` key). Tests use `httpx.AsyncClient(transport=ASGITransport(app=app))`.

- [ ] **Step 1: Create branch and .gitignore**

```bash
git checkout -b feat/foundation
```

Create `.gitignore` at repo root:

```gitignore
# Python
__pycache__/
*.pyc
.venv/
.pytest_cache/
.ruff_cache/

# Node
node_modules/
.next/
frontend/test-results/
frontend/playwright-report/

# Env
.env
```

- [ ] **Step 2: Write backend/pyproject.toml**

```toml
[project]
name = "issuelens-backend"
version = "0.1.0"
description = "IssueLens API"
requires-python = ">=3.12"
dependencies = [
    "fastapi>=0.115",
    "uvicorn[standard]>=0.30",
    "pydantic-settings>=2.4",
    "sqlalchemy[asyncio]>=2.0.32",
    "asyncpg>=0.29",
    "alembic>=1.13",
    "arq>=0.26",
]

[dependency-groups]
dev = [
    "pytest>=8",
    "pytest-asyncio>=0.24",
    "httpx>=0.27",
    "ruff>=0.6",
]

[tool.pytest.ini_options]
asyncio_mode = "auto"
testpaths = ["tests"]

[tool.ruff]
line-length = 100
```

Run: `cd backend && uv sync` — creates `.venv` and `uv.lock`. Expected: resolves and installs with no errors.

- [ ] **Step 3: Write the failing tests**

`backend/tests/conftest.py`:

```python
import pytest

from app.config import get_settings


@pytest.fixture(autouse=True)
def pin_env(monkeypatch):
    """Pin behavior-affecting env vars explicitly; never inherit host state silently."""
    monkeypatch.setenv(
        "ISSUELENS_DATABASE_URL",
        "postgresql+asyncpg://issuelens:issuelens@localhost:5432/issuelens",
    )
    monkeypatch.setenv("ISSUELENS_REDIS_URL", "redis://localhost:6379/0")
    get_settings.cache_clear()
    yield
    get_settings.cache_clear()
```

`backend/tests/test_config.py`:

```python
from app.config import get_settings


def test_settings_read_prefixed_env(monkeypatch):
    monkeypatch.setenv("ISSUELENS_DATABASE_URL", "postgresql+asyncpg://u:p@example:5432/db")
    get_settings.cache_clear()
    assert get_settings().database_url == "postgresql+asyncpg://u:p@example:5432/db"


def test_settings_have_defaults():
    s = get_settings()
    assert s.database_url.startswith("postgresql+asyncpg://")
    assert s.redis_url.startswith("redis://")
```

`backend/tests/test_health.py`:

```python
from httpx import ASGITransport, AsyncClient

from app.main import app


async def test_healthz_returns_ok():
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        resp = await client.get("/healthz")
    assert resp.status_code == 200
    assert resp.json()["status"] == "ok"
```

Also create empty `backend/app/__init__.py` and `backend/tests/__init__.py`.

- [ ] **Step 4: Run tests to verify they fail**

Run: `cd backend && uv run pytest -v`
Expected: FAIL / errors with `ModuleNotFoundError: No module named 'app.config'` (or `'app.main'`).

- [ ] **Step 5: Implement config and app**

`backend/app/config.py`:

```python
from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="ISSUELENS_", extra="ignore")

    database_url: str = "postgresql+asyncpg://issuelens:issuelens@localhost:5432/issuelens"
    redis_url: str = "redis://localhost:6379/0"


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    return Settings()
```

`backend/app/main.py`:

```python
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse


@asynccontextmanager
async def lifespan(app: FastAPI):
    yield


app = FastAPI(title="IssueLens API", lifespan=lifespan)


@app.exception_handler(Exception)
async def unhandled_exception_handler(request: Request, exc: Exception) -> JSONResponse:
    return JSONResponse(status_code=500, content={"detail": "Internal server error"})


@app.get("/healthz")
async def healthz() -> dict:
    return {"status": "ok"}
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `cd backend && uv run pytest -v`
Expected: 3 passed.

- [ ] **Step 7: Lint and commit**

Run: `cd backend && uv run ruff check .` — expected: no findings.

```bash
git add .gitignore backend/
git commit -m "feat(backend): FastAPI skeleton with settings and /healthz"
```

---

### Task 2: Docker Compose — postgres, redis, backend

**Files:**
- Create: `backend/Dockerfile`, `docker-compose.yml`, `.env.example`

**Interfaces:**
- Consumes: `backend/` from Task 1 (`app.main:app`, `uv.lock`).
- Produces: compose services `postgres` (localhost:5432, user/pass/db all `issuelens`, image `pgvector/pgvector:pg17`), `redis` (localhost:6379), `backend` (localhost:8000). Tasks 3–5 and 8 depend on these names and ports.

- [ ] **Step 1: Write backend/Dockerfile**

```dockerfile
FROM python:3.12-slim

COPY --from=ghcr.io/astral-sh/uv:latest /uv /usr/local/bin/uv

WORKDIR /app
ENV UV_PROJECT_ENVIRONMENT=/opt/venv

COPY pyproject.toml uv.lock ./
RUN uv sync --frozen

COPY . .

EXPOSE 8000
CMD ["uv", "run", "uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000", "--reload"]
```

- [ ] **Step 2: Write docker-compose.yml (repo root)**

```yaml
services:
  postgres:
    image: pgvector/pgvector:pg17
    environment:
      POSTGRES_USER: issuelens
      POSTGRES_PASSWORD: issuelens
      POSTGRES_DB: issuelens
    ports:
      - "5432:5432"
    volumes:
      - pgdata:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U issuelens -d issuelens"]
      interval: 5s
      timeout: 5s
      retries: 10

  redis:
    image: redis:7
    ports:
      - "6379:6379"
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 5s
      timeout: 5s
      retries: 10

  backend:
    build: ./backend
    environment:
      ISSUELENS_DATABASE_URL: postgresql+asyncpg://issuelens:issuelens@postgres:5432/issuelens
      ISSUELENS_REDIS_URL: redis://redis:6379/0
    ports:
      - "8000:8000"
    volumes:
      - ./backend/app:/app/app
    depends_on:
      postgres:
        condition: service_healthy
      redis:
        condition: service_healthy

volumes:
  pgdata:
```

- [ ] **Step 3: Write .env.example (repo root)**

```sh
# Copy to .env if you need to override compose defaults. Keep this file in sync
# with docker-compose.yml environment vars IN THE SAME COMMIT (house rule).

# Backend (defaults match docker-compose.yml; host-run backend/tests use localhost)
ISSUELENS_DATABASE_URL=postgresql+asyncpg://issuelens:issuelens@localhost:5432/issuelens
ISSUELENS_REDIS_URL=redis://localhost:6379/0
```

- [ ] **Step 4: Verify the stack comes up**

Run: `docker compose up -d --build postgres redis backend`
Then: `curl -s http://localhost:8000/healthz`
Expected: `{"status":"ok"}` — and `docker compose ps` shows postgres/redis `healthy`.

- [ ] **Step 5: Commit**

```bash
git add backend/Dockerfile docker-compose.yml .env.example
git commit -m "feat(infra): docker-compose with postgres+pgvector, redis, backend"
```

---

### Task 3: Database layer — async engine, Alembic, pgvector migration, DB-aware /healthz

**Files:**
- Create: `backend/app/db.py`, `backend/alembic.ini`, `backend/alembic/env.py`, `backend/alembic/script.py.mako` (generated), `backend/alembic/versions/0001_enable_pgvector.py`, `backend/tests/test_db.py`
- Modify: `backend/app/main.py` (healthz gains `"database"` key), `backend/tests/conftest.py` (clear engine cache), `backend/tests/test_health.py` (assert `"database": "ok"`)

**Interfaces:**
- Consumes: `get_settings()` from Task 1; compose `postgres` from Task 2 (must be up).
- Produces: `app.db.get_engine() -> AsyncEngine` (`@lru_cache`, `pool_pre_ping=True`); Alembic revision `0001` (head) enabling the `vector` extension; `GET /healthz -> {"status": "ok", "database": "ok" | "unavailable"}`.

- [ ] **Step 1: Generate Alembic scaffolding, then replace config**

Run: `cd backend && uv run alembic init alembic`

Replace generated `backend/alembic.ini` content with:

```ini
[alembic]
script_location = alembic
prepend_sys_path = .

[loggers]
keys = root,sqlalchemy,alembic

[handlers]
keys = console

[formatters]
keys = generic

[logger_root]
level = WARNING
handlers = console
qualname =

[logger_sqlalchemy]
level = WARNING
handlers =
qualname = sqlalchemy.engine

[logger_alembic]
level = INFO
handlers =
qualname = alembic

[handler_console]
class = StreamHandler
args = (sys.stderr,)
level = NOTSET
formatter = generic

[formatter_generic]
format = %(levelname)-5.5s [%(name)s] %(message)s
datefmt = %H:%M:%S
```

Replace generated `backend/alembic/env.py` content with:

```python
import asyncio
from logging.config import fileConfig

from alembic import context
from sqlalchemy import pool
from sqlalchemy.ext.asyncio import async_engine_from_config

from app.config import get_settings

config = context.config
if config.config_file_name is not None:
    fileConfig(config.config_file_name)

config.set_main_option("sqlalchemy.url", get_settings().database_url)
target_metadata = None


def run_migrations_offline() -> None:
    context.configure(url=config.get_main_option("sqlalchemy.url"), literal_binds=True)
    with context.begin_transaction():
        context.run_migrations()


def do_run_migrations(connection) -> None:
    context.configure(connection=connection, target_metadata=target_metadata)
    with context.begin_transaction():
        context.run_migrations()


async def run_migrations_online() -> None:
    connectable = async_engine_from_config(
        config.get_section(config.config_ini_section, {}),
        prefix="sqlalchemy.",
        poolclass=pool.NullPool,
    )
    async with connectable.connect() as connection:
        await connection.run_sync(do_run_migrations)
    await connectable.dispose()


if context.is_offline_mode():
    run_migrations_offline()
else:
    asyncio.run(run_migrations_online())
```

Keep the generated `script.py.mako`; delete nothing else.

- [ ] **Step 2: Write the pgvector migration**

`backend/alembic/versions/0001_enable_pgvector.py`:

```python
"""enable pgvector extension"""

from alembic import op

revision = "0001"
down_revision = None
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("CREATE EXTENSION IF NOT EXISTS vector")


def downgrade() -> None:
    op.execute("DROP EXTENSION IF EXISTS vector")
```

- [ ] **Step 3: Write the failing tests**

`backend/tests/test_db.py`:

```python
from sqlalchemy import text

from app.db import get_engine


async def test_engine_connects():
    async with get_engine().connect() as conn:
        result = await conn.execute(text("SELECT 1"))
        assert result.scalar() == 1


async def test_pgvector_extension_enabled():
    async with get_engine().connect() as conn:
        result = await conn.execute(
            text("SELECT extname FROM pg_extension WHERE extname = 'vector'")
        )
        assert result.scalar() == "vector"
```

Update `backend/tests/test_health.py` — replace the existing test body's assertions:

```python
from httpx import ASGITransport, AsyncClient

from app.main import app


async def test_healthz_returns_ok_with_database():
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        resp = await client.get("/healthz")
    assert resp.status_code == 200
    body = resp.json()
    assert body["status"] == "ok"
    assert body["database"] == "ok"
```

Update `backend/tests/conftest.py` — add the engine-cache clear (full new content):

```python
import pytest

from app.config import get_settings
from app.db import get_engine


@pytest.fixture(autouse=True)
def pin_env(monkeypatch):
    """Pin behavior-affecting env vars explicitly; never inherit host state silently."""
    monkeypatch.setenv(
        "ISSUELENS_DATABASE_URL",
        "postgresql+asyncpg://issuelens:issuelens@localhost:5432/issuelens",
    )
    monkeypatch.setenv("ISSUELENS_REDIS_URL", "redis://localhost:6379/0")
    get_settings.cache_clear()
    get_engine.cache_clear()
    yield
    get_settings.cache_clear()
    get_engine.cache_clear()
```

- [ ] **Step 4: Run tests to verify they fail**

Run: `docker compose up -d postgres` then `cd backend && uv run pytest -v`
Expected: `test_db.py` errors with `ModuleNotFoundError: No module named 'app.db'`; health test fails on missing `"database"` key.

- [ ] **Step 5: Implement db.py and extend healthz**

`backend/app/db.py`:

```python
from functools import lru_cache

from sqlalchemy.ext.asyncio import AsyncEngine, create_async_engine

from app.config import get_settings


@lru_cache(maxsize=1)
def get_engine() -> AsyncEngine:
    return create_async_engine(get_settings().database_url, pool_pre_ping=True)
```

Replace the `healthz` function in `backend/app/main.py` (add imports `from sqlalchemy import text` and `from app.db import get_engine` at the top):

```python
@app.get("/healthz")
async def healthz() -> dict:
    database = "ok"
    try:
        async with get_engine().connect() as conn:
            await conn.execute(text("SELECT 1"))
    except Exception:
        database = "unavailable"
    return {"status": "ok", "database": database}
```

- [ ] **Step 6: Run migration, then tests**

Run: `cd backend && uv run alembic upgrade head`
Expected: `Running upgrade  -> 0001, enable pgvector extension`.

Run: `uv run pytest -v`
Expected: all tests pass (5 total).

- [ ] **Step 7: Lint and commit**

Run: `uv run ruff check .` — expected: clean.

```bash
git add backend/
git commit -m "feat(backend): async db engine, alembic, pgvector migration, db-aware healthz"
```

---

### Task 4: ARQ worker — no-op job, compose service, round-trip test

**Files:**
- Create: `backend/worker.py`, `backend/tests/test_worker.py`
- Modify: `docker-compose.yml` (add `worker` service)

**Interfaces:**
- Consumes: `get_settings()` (Task 1), compose `redis` (Task 2).
- Produces: `worker.WorkerSettings` (ARQ entrypoint; functions: `ping(ctx) -> "pong"`); compose service `worker`. Board #3's sync jobs will register in this same `WorkerSettings.functions` list.

- [ ] **Step 1: Write the failing test**

`backend/tests/test_worker.py`:

```python
from arq import create_pool
from arq.connections import RedisSettings

from app.config import get_settings


async def test_ping_job_round_trip():
    """Requires the worker container: docker compose up -d worker"""
    pool = await create_pool(RedisSettings.from_dsn(get_settings().redis_url))
    job = await pool.enqueue_job("ping")
    result = await job.result(timeout=10)
    assert result == "pong"
    await pool.aclose()
```

- [ ] **Step 2: Run test to verify it fails**

Run: `docker compose up -d redis` then `cd backend && uv run pytest tests/test_worker.py -v`
Expected: FAIL — the job is enqueued but no worker exists, so `job.result(timeout=10)` raises `TimeoutError` (or `asyncio.TimeoutError`).

- [ ] **Step 3: Implement the worker**

`backend/worker.py`:

```python
from arq.connections import RedisSettings

from app.config import get_settings


async def ping(ctx: dict) -> str:
    return "pong"


class WorkerSettings:
    functions = [ping]
    redis_settings = RedisSettings.from_dsn(get_settings().redis_url)
```

Add to `docker-compose.yml` services (after `backend`):

```yaml
  worker:
    build: ./backend
    command: ["uv", "run", "arq", "worker.WorkerSettings"]
    environment:
      ISSUELENS_DATABASE_URL: postgresql+asyncpg://issuelens:issuelens@postgres:5432/issuelens
      ISSUELENS_REDIS_URL: redis://redis:6379/0
    volumes:
      - ./backend/app:/app/app
      - ./backend/worker.py:/app/worker.py
    depends_on:
      redis:
        condition: service_healthy
```

- [ ] **Step 4: Run test to verify it passes**

Run: `docker compose up -d --build worker` then `cd backend && uv run pytest tests/test_worker.py -v`
Expected: PASS. Also `docker compose logs worker` shows `Starting worker` with `ping` registered.

- [ ] **Step 5: Lint and commit**

Run: `uv run ruff check .` — expected: clean.

```bash
git add backend/worker.py backend/tests/test_worker.py docker-compose.yml
git commit -m "feat(backend): arq worker with ping job and compose service"
```

---

### Task 5: Frontend scaffold — Next.js, proxy route, TanStack Query, compose service

**Files:**
- Create: `frontend/` via create-next-app, `frontend/src/app/api/backend/[...path]/route.ts`, `frontend/src/app/providers.tsx`, `frontend/Dockerfile`
- Modify: `frontend/package.json` (add `dev:local` script), `frontend/src/app/layout.tsx` (wrap in Providers), `docker-compose.yml` (add `frontend` service)

**Interfaces:**
- Consumes: compose `backend` on `:8000` (Task 2).
- Produces: Next.js app on `:3000`; proxy `GET/POST/PUT/PATCH/DELETE /api/backend/* → ${BACKEND_URL}/*` (env `BACKEND_URL`, default `http://localhost:8000`); `Providers` client component wrapping `QueryClientProvider`. Task 7 modifies `layout.tsx` further; Task 8 tests against `:3000`.

- [ ] **Step 1: Scaffold Next.js**

Run from repo root:

```bash
npx create-next-app@latest frontend --typescript --eslint --app --src-dir --tailwind --turbopack --no-import-alias --use-npm
```

Then: `cd frontend && npm install @tanstack/react-query`

- [ ] **Step 2: Add dev:local script**

In `frontend/package.json` `"scripts"`, add:

```json
"dev:local": "node -e \"require('fs').rmSync('.next',{recursive:true,force:true})\" && next dev"
```

(`BACKEND_URL` defaults to `http://localhost:8000` in code, so no env juggling is needed on the host; `.next` is cleared to avoid the stale-Turbopack-cache trap after branch switches.)

- [ ] **Step 3: Write the proxy route**

`frontend/src/app/api/backend/[...path]/route.ts`:

```ts
import { NextRequest } from "next/server";

const BACKEND_URL = process.env.BACKEND_URL ?? "http://localhost:8000";

async function proxy(
  req: NextRequest,
  { params }: { params: Promise<{ path: string[] }> },
) {
  const { path } = await params;
  const url = new URL(req.url);
  const target = `${BACKEND_URL}/${path.join("/")}${url.search}`;
  const res = await fetch(target, {
    method: req.method,
    headers: {
      "content-type": req.headers.get("content-type") ?? "application/json",
    },
    body:
      req.method === "GET" || req.method === "HEAD"
        ? undefined
        : await req.arrayBuffer(),
    cache: "no-store",
  });
  return new Response(res.body, {
    status: res.status,
    headers: {
      "content-type": res.headers.get("content-type") ?? "application/json",
    },
  });
}

export {
  proxy as GET,
  proxy as POST,
  proxy as PUT,
  proxy as PATCH,
  proxy as DELETE,
};
```

- [ ] **Step 4: Wire TanStack Query provider**

`frontend/src/app/providers.tsx`:

```tsx
"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState } from "react";

export function Providers({ children }: { children: React.ReactNode }) {
  const [queryClient] = useState(() => new QueryClient());
  return (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
}
```

In `frontend/src/app/layout.tsx`, import `Providers` and wrap the body content: `<body>...<Providers>{children}</Providers>...</body>` (keep the generated font class names as-is for now; Task 7 rewrites this layout).

- [ ] **Step 5: Write frontend/Dockerfile and compose service**

`frontend/Dockerfile`:

```dockerfile
FROM node:22-alpine

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . .

EXPOSE 3000
CMD ["npm", "run", "dev"]
```

Add to `docker-compose.yml` services (after `worker`):

```yaml
  frontend:
    build: ./frontend
    environment:
      BACKEND_URL: http://backend:8000
    ports:
      - "3000:3000"
    volumes:
      - ./frontend:/app
      - /app/node_modules
    depends_on:
      - backend
```

And add `BACKEND_URL=http://localhost:8000` under a `# Frontend` heading in `.env.example` (same commit — house rule).

- [ ] **Step 6: Verify lint, build, and proxy**

Run: `cd frontend && npm run lint` — expected: no errors.
Run: `npm run build` — expected: compiled successfully.
Run: `docker compose up -d --build frontend`, then `npm run dev:local` in another terminal is NOT needed for this check — instead:
`curl -s http://localhost:3000/api/backend/healthz`
Expected: `{"status":"ok","database":"ok"}` (proxied through Next to FastAPI).

- [ ] **Step 7: Commit**

```bash
git add frontend/ docker-compose.yml .env.example
git commit -m "feat(frontend): next.js scaffold with backend proxy, tanstack query, compose service"
```

---

### Task 6: Theme system — tokens, dark default, toggle

**Files:**
- Create: `frontend/src/components/theme-toggle.tsx`
- Modify: `frontend/src/app/globals.css` (replace content), `frontend/src/app/layout.tsx` (replace content)

**Interfaces:**
- Consumes: scaffold from Task 5.
- Produces: token set `--color-bg`, `--color-surface`, `--color-border`, `--color-text`, `--color-text-muted`, `--color-primary`, `--accent-tint`, `--flash` scoped to `:root`/`:root[data-mode="dark"]`; `<html data-mode>` with dark default, persisted at `localStorage["issuelens-mode"]`; `<ThemeToggle />` client component. Task 7's components consume only these tokens; Task 8 asserts on `data-mode`.

- [ ] **Step 1: Replace globals.css**

`frontend/src/app/globals.css` (full content — the token block is the validated set from the sketch findings; extend, don't fork):

```css
@import "tailwindcss";

:root {
  /* light */
  --color-bg: #f4f4f6;
  --color-surface: #ffffff;
  --color-border: #e3e3e8;
  --color-text: #17181c;
  --color-text-muted: #6e7076;
  --color-primary: #5b5bd6;
  --accent-tint: rgba(91, 91, 214, 0.1);
  --flash: #eeeefc;
}

:root[data-mode="dark"] {
  --color-bg: #101013;
  --color-surface: #17171b;
  --color-border: #26262c;
  --color-text: #ededf0;
  --color-text-muted: #9698a1;
  --color-primary: #7b7bec;
  --accent-tint: rgba(123, 123, 236, 0.16);
  --flash: #2c2c46;
}

body {
  background: var(--color-bg);
  color: var(--color-text);
  font-family:
    -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial,
    sans-serif;
  font-size: 13px;
  transition: background 0.15s ease, color 0.15s ease;
}
```

- [ ] **Step 2: Rewrite layout.tsx with dark default + pre-hydration mode script**

`frontend/src/app/layout.tsx` (full content):

```tsx
import type { Metadata } from "next";
import "./globals.css";
import { Providers } from "./providers";

export const metadata: Metadata = {
  title: "IssueLens",
  description: "Developer-centric intelligence dashboard over GitHub Issues",
};

const modeScript = `try{var m=localStorage.getItem("issuelens-mode");if(m==="light"||m==="dark")document.documentElement.setAttribute("data-mode",m)}catch(e){}`;

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" data-mode="dark" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: modeScript }} />
      </head>
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
```

(Delete the generated Geist font imports/classes — the design uses the system sans stack.)

- [ ] **Step 3: Write the theme toggle**

`frontend/src/components/theme-toggle.tsx`:

```tsx
"use client";

import { useEffect, useState } from "react";

type Mode = "dark" | "light";

export function ThemeToggle() {
  const [mode, setMode] = useState<Mode>("dark");

  useEffect(() => {
    const current = document.documentElement.getAttribute("data-mode");
    if (current === "light" || current === "dark") setMode(current);
  }, []);

  function toggle() {
    const next: Mode = mode === "dark" ? "light" : "dark";
    document.documentElement.setAttribute("data-mode", next);
    try {
      localStorage.setItem("issuelens-mode", next);
    } catch {
      /* private mode etc. — toggle still works for the session */
    }
    setMode(next);
  }

  return (
    <button
      type="button"
      onClick={toggle}
      aria-label={`Switch to ${mode === "dark" ? "light" : "dark"} mode`}
      className="rounded-lg border border-(--color-border) bg-(--color-surface) px-2.5 py-1.5 text-(--color-text-muted) transition-all duration-150 hover:text-(--color-text)"
    >
      {mode === "dark" ? "☀" : "☾"}
    </button>
  );
}
```

- [ ] **Step 4: Verify**

Run: `cd frontend && npm run lint && npm run build` — expected: clean build.
(The toggle's behavior is asserted by Playwright in Task 8; no manual-browser verification claims.)

- [ ] **Step 5: Commit**

```bash
git add frontend/src/
git commit -m "feat(frontend): dual-theme token system with dark default and toggle"
```

---

### Task 7: App shell — header, sidebar, right panel, six routes with empty states

**Files:**
- Create: `frontend/src/components/app-shell.tsx`, `frontend/src/components/header.tsx`, `frontend/src/components/sidenav.tsx`, `frontend/src/components/page-placeholder.tsx`, `frontend/src/app/triage/page.tsx`, `frontend/src/app/plan/page.tsx`, `frontend/src/app/analyze/page.tsx`, `frontend/src/app/views/page.tsx`, `frontend/src/app/repositories/page.tsx`
- Modify: `frontend/src/app/layout.tsx` (mount AppShell), `frontend/src/app/page.tsx` (replace content)

**Interfaces:**
- Consumes: tokens + `ThemeToggle` (Task 6).
- Produces: `<AppShell>{children}</AppShell>` (header + grid `216px minmax(0,1fr) 330px`), `NAV_ITEMS: { group: string; items: { label: string; href: string }[] }[]` in `sidenav.tsx`, `<PagePlaceholder title="..." hint="..." emptyTitle="..." emptyBody="..." />`. Task 8 navigates these routes and asserts `h1` text.

- [ ] **Step 1: Write the sidenav**

`frontend/src/components/sidenav.tsx`:

```tsx
"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

export const NAV_ITEMS = [
  {
    group: "Workspace",
    items: [
      { label: "Overview", href: "/" },
      { label: "Triage", href: "/triage" },
      { label: "Plan", href: "/plan" },
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

export function Sidenav() {
  const pathname = usePathname();
  return (
    <nav aria-label="Primary" className="flex flex-col gap-5 py-1">
      {NAV_ITEMS.map(({ group, items }) => (
        <div key={group}>
          <div className="px-3 pb-1.5 text-[10px] font-semibold tracking-[0.08em] text-(--color-text-muted) uppercase">
            {group}
          </div>
          <ul className="flex flex-col gap-0.5">
            {items.map(({ label, href }) => {
              const active = pathname === href;
              return (
                <li key={href}>
                  <Link
                    href={href}
                    aria-current={active ? "page" : undefined}
                    className={`flex items-center justify-between rounded-lg px-3 py-1.5 transition-all duration-150 ${
                      active
                        ? "bg-(--accent-tint) font-medium text-(--color-primary)"
                        : "text-(--color-text-muted) hover:bg-(--accent-tint) hover:text-(--color-text)"
                    }`}
                  >
                    <span>{label}</span>
                    <span className="rounded-full border border-(--color-border) px-1.5 text-[10px] text-(--color-text-muted)">
                      –
                    </span>
                  </Link>
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

- [ ] **Step 2: Write the header**

`frontend/src/components/header.tsx`:

```tsx
import { ThemeToggle } from "./theme-toggle";

export function Header() {
  return (
    <header className="flex items-center gap-3 border-b border-(--color-border) px-5 py-2.5">
      <div className="flex items-center gap-1.5 font-semibold">
        <span className="inline-block h-2.5 w-2.5 rounded-full bg-(--color-primary)" />
        IssueLens
      </div>
      <span className="rounded-lg border border-(--color-border) bg-(--color-surface) px-2 py-1 text-(--color-text-muted)">
        No repository connected
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

- [ ] **Step 3: Write the app shell**

`frontend/src/components/app-shell.tsx`:

```tsx
import { Header } from "./header";
import { Sidenav } from "./sidenav";

export function AppShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col">
      <Header />
      <div className="grid grow grid-cols-[216px_minmax(0,1fr)_330px] gap-5 p-5">
        <Sidenav />
        <main className="min-w-0">{children}</main>
        <aside>
          <div className="rounded-[14px] border border-(--color-border) bg-(--color-surface) p-4 text-(--color-text-muted) shadow-[0_1px_2px_rgba(31,35,40,0.06)]">
            <div className="pb-1 text-[10px] font-semibold tracking-[0.08em] uppercase">
              Context
            </div>
            Details about your selection will appear here once data is
            connected.
          </div>
        </aside>
      </div>
    </div>
  );
}
```

In `frontend/src/app/layout.tsx`, import `AppShell` and change the body line to:

```tsx
<Providers>
  <AppShell>{children}</AppShell>
</Providers>
```

- [ ] **Step 4: Write the page placeholder component**

`frontend/src/components/page-placeholder.tsx`:

```tsx
export function PagePlaceholder({
  title,
  hint,
  emptyTitle,
  emptyBody,
}: {
  title: string;
  hint: string;
  emptyTitle: string;
  emptyBody: string;
}) {
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-baseline gap-3">
        <h1 className="text-lg font-semibold tracking-[-0.01em]">{title}</h1>
        <span className="text-(--color-text-muted)">{hint}</span>
      </div>
      <div className="flex flex-col items-center gap-1.5 rounded-[14px] border border-(--color-border) bg-(--color-surface) px-6 py-16 text-center shadow-[0_1px_2px_rgba(31,35,40,0.06)]">
        <div className="text-sm font-medium">{emptyTitle}</div>
        <div className="max-w-md text-(--color-text-muted)">{emptyBody}</div>
      </div>
    </div>
  );
}
```

- [ ] **Step 5: Write all six pages**

`frontend/src/app/page.tsx` (full replacement):

```tsx
import { PagePlaceholder } from "../components/page-placeholder";

export default function OverviewPage() {
  return (
    <PagePlaceholder
      title="Overview"
      hint="Your issue landscape at a glance"
      emptyTitle="Connect a repository to begin"
      emptyBody="Once a repository is connected, this page shows readiness, triage load, and delivery signals across your issues."
    />
  );
}
```

`frontend/src/app/triage/page.tsx`:

```tsx
import { PagePlaceholder } from "../../components/page-placeholder";

export default function TriagePage() {
  return (
    <PagePlaceholder
      title="Triage"
      hint="Issues that need attention first"
      emptyTitle="Nothing to triage yet"
      emptyBody="After your first sync, new and incomplete issues land here with readiness scores and suggested next steps."
    />
  );
}
```

`frontend/src/app/plan/page.tsx`:

```tsx
import { PagePlaceholder } from "../../components/page-placeholder";

export default function PlanPage() {
  return (
    <PagePlaceholder
      title="Plan"
      hint="Board, matrix, and dependencies"
      emptyTitle="No plan to show yet"
      emptyBody="The kanban board, priority matrix, and dependency map light up here once issues are synced."
    />
  );
}
```

`frontend/src/app/analyze/page.tsx`:

```tsx
import { PagePlaceholder } from "../../components/page-placeholder";

export default function AnalyzePage() {
  return (
    <PagePlaceholder
      title="Analyze"
      hint="Delivery analytics and insights"
      emptyTitle="No analytics yet"
      emptyBody="Trends, risks, and actionable insights appear here after your issues have some history to analyze."
    />
  );
}
```

`frontend/src/app/views/page.tsx`:

```tsx
import { PagePlaceholder } from "../../components/page-placeholder";

export default function SavedViewsPage() {
  return (
    <PagePlaceholder
      title="Saved Views"
      hint="Your custom filters, one click away"
      emptyTitle="No saved views yet"
      emptyBody="Save any filtered table or board as a named view and it will be listed here."
    />
  );
}
```

`frontend/src/app/repositories/page.tsx`:

```tsx
import { PagePlaceholder } from "../../components/page-placeholder";

export default function RepositoriesPage() {
  return (
    <PagePlaceholder
      title="Repositories"
      hint="Connected sources"
      emptyTitle="No repositories connected"
      emptyBody="Connecting GitHub repositories is coming in the next milestone — synced repos and their status will be managed here."
    />
  );
}
```

- [ ] **Step 6: Verify**

Run: `cd frontend && npm run lint && npm run build`
Expected: clean; build lists routes `/`, `/triage`, `/plan`, `/analyze`, `/views`, `/repositories`, `/api/backend/[...path]`.

- [ ] **Step 7: Commit**

```bash
git add frontend/src/
git commit -m "feat(frontend): app shell with sidebar, header, right panel, six routes"
```

---

### Task 8: Playwright smoke tests

**Files:**
- Create: `frontend/playwright.config.ts`, `frontend/e2e/shell.spec.ts`
- Modify: `frontend/package.json` (add `test:e2e` script)

**Interfaces:**
- Consumes: routes and `data-mode` behavior from Tasks 6–7.
- Produces: `npm run test:e2e` (Playwright CLI). CI does not run this job (local gate only for this slice).

- [ ] **Step 1: Install Playwright**

Run: `cd frontend && npm install -D @playwright/test && npx playwright install chromium`

Add to `frontend/package.json` scripts:

```json
"test:e2e": "playwright test"
```

- [ ] **Step 2: Write playwright.config.ts**

`frontend/playwright.config.ts`:

```ts
import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  use: {
    baseURL: "http://localhost:3000",
  },
  webServer: {
    command: "npm run dev",
    url: "http://localhost:3000",
    reuseExistingServer: true,
    timeout: 120_000,
  },
});
```

- [ ] **Step 3: Write the smoke tests**

`frontend/e2e/shell.spec.ts`:

```ts
import { expect, test } from "@playwright/test";

const ROUTES = [
  { link: "Overview", href: "/", h1: "Overview" },
  { link: "Triage", href: "/triage", h1: "Triage" },
  { link: "Plan", href: "/plan", h1: "Plan" },
  { link: "Analyze", href: "/analyze", h1: "Analyze" },
  { link: "Saved Views", href: "/views", h1: "Saved Views" },
  { link: "Repositories", href: "/repositories", h1: "Repositories" },
];

test("shell renders in dark mode by default", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("html")).toHaveAttribute("data-mode", "dark");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Overview");
});

test("all sidebar routes navigate", async ({ page }) => {
  await page.goto("/");
  for (const { link, href, h1 } of ROUTES) {
    await page.getByRole("navigation", { name: "Primary" }).getByRole("link", { name: link }).click();
    await expect(page).toHaveURL(href);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(h1);
  }
});

test("theme toggle flips data-mode and persists across reload", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: /switch to light mode/i }).click();
  await expect(page.locator("html")).toHaveAttribute("data-mode", "light");
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-mode", "light");
  await page.getByRole("button", { name: /switch to dark mode/i }).click();
  await expect(page.locator("html")).toHaveAttribute("data-mode", "dark");
});
```

- [ ] **Step 4: Run the tests**

Run: `cd frontend && npm run test:e2e`
Expected: 3 passed (webServer starts `next dev` automatically if :3000 is free).

- [ ] **Step 5: Commit**

```bash
git add frontend/playwright.config.ts frontend/e2e/ frontend/package.json frontend/package-lock.json
git commit -m "test(frontend): playwright smoke for shell, navigation, theme"
```

---

### Task 9: CI workflow and README

**Files:**
- Create: `.github/workflows/ci.yml`, `README.md` (replace if the initial commit left one)

**Interfaces:**
- Consumes: everything above.
- Produces: GitHub Actions `CI` with `backend` and `frontend` jobs, required green before PR merge.

- [ ] **Step 1: Write the CI workflow**

`.github/workflows/ci.yml`:

```yaml
name: CI

on:
  push:
    branches: [main]
  pull_request:

jobs:
  backend:
    runs-on: ubuntu-latest
    defaults:
      run:
        working-directory: backend
    services:
      postgres:
        image: pgvector/pgvector:pg17
        env:
          POSTGRES_USER: issuelens
          POSTGRES_PASSWORD: issuelens
          POSTGRES_DB: issuelens
        ports:
          - 5432:5432
        options: >-
          --health-cmd "pg_isready -U issuelens"
          --health-interval 5s
          --health-timeout 5s
          --health-retries 10
      redis:
        image: redis:7
        ports:
          - 6379:6379
        options: >-
          --health-cmd "redis-cli ping"
          --health-interval 5s
          --health-timeout 5s
          --health-retries 10
    steps:
      - uses: actions/checkout@v4
      - uses: astral-sh/setup-uv@v4
      - run: uv sync
      - run: uv run ruff check .
      - run: uv run alembic upgrade head
      - run: nohup uv run arq worker.WorkerSettings > /tmp/worker.log 2>&1 &
      - run: uv run pytest -v

  frontend:
    runs-on: ubuntu-latest
    defaults:
      run:
        working-directory: frontend
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: npm
          cache-dependency-path: frontend/package-lock.json
      - run: npm ci
      - run: npm run lint
      - run: npm run build
```

- [ ] **Step 2: Write the README**

`README.md` (full content):

````markdown
# IssueLens

Developer-centric intelligence dashboard over GitHub Issues.
Product spec: `issuelens_github_issue_dashboard_spec.md`.

## Quickstart

```sh
docker compose up --build        # postgres+pgvector, redis, backend :8000, worker, frontend :3000
```

Then run migrations once: `cd backend && uv run alembic upgrade head`

- Dashboard: http://localhost:3000
- API health: http://localhost:8000/healthz

## Development loop

The Dockerized frontend dev server does NOT reliably hot-reload host file edits on
Windows volume mounts. The primary dev loop is a host dev server against the Docker
backend:

```sh
docker compose up -d postgres redis backend worker
cd frontend && npm run dev:local     # clears .next, runs next dev on the host
```

### Known traps

- After adding a frontend dependency, the anonymous node_modules volume shadows the
  image. Fix: `docker compose up -d --build --renew-anon-volumes frontend`
- If the Dockerized frontend serves stale code after edits: `docker compose restart frontend`

## Tests

```sh
# Backend (needs: docker compose up -d postgres redis worker; migrations at head)
cd backend && uv run pytest -v

# Frontend lint + types
cd frontend && npm run lint && npm run build

# UI smoke (Playwright CLI)
cd frontend && npm run test:e2e
```

## Task tracking

Work lives on the private IssueLens Roadmap board — see `CLAUDE.md` (Task Tracking)
and the `todos` skill.
````

- [ ] **Step 3: Verify and commit**

Run: `cd backend && uv run pytest -v` (with compose postgres/redis/worker up) — expected: all pass.
Run: `cd frontend && npm run lint && npm run build` — expected: clean.

```bash
git add .github/ README.md
git commit -m "chore: CI workflow and README"
```

- [ ] **Step 4: Push branch and pause**

```bash
git push -u origin feat/foundation
```

Set board items In Progress → done is NOT yet claimed: per house rules, surface a summary and **ask the user before opening a PR**. CI must be green on the pushed branch first.

---

## Final verification (whole slice)

- [ ] `docker compose up --build` from scratch (after `docker compose down -v`): frontend at :3000 shows the dark shell; `/healthz` at :8000 returns `{"status":"ok","database":"ok"}` after `alembic upgrade head`; `docker compose ps` shows postgres/redis healthy and worker running.
- [ ] `cd backend && uv run pytest -v` — all pass.
- [ ] `cd frontend && npm run test:e2e` — 3 passed.
- [ ] CI green on `feat/foundation`.
- [ ] `/todos start 1` and `/todos start 2` were run at kickoff; completion (`/todos done`) happens only after the PR merges.
