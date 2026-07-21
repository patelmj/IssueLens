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
    monkeypatch.setenv("ISSUELENS_OLLAMA_URL", "http://127.0.0.1:11434")
    monkeypatch.setenv("ISSUELENS_OLLAMA_MODEL", "test-model")
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
                "TRUNCATE installations, repositories, issues, issue_classifications, "
                "issue_readiness, issue_priority, issue_priority_pins, issue_workflow, "
                "saved_views, sync_jobs RESTART IDENTITY CASCADE"
            )
        )
    yield
