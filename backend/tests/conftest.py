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
