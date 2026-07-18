import pytest

from app.config import get_settings
from app.db import get_engine


@pytest.fixture(autouse=True)
async def pin_env(monkeypatch):
    """Pin behavior-affecting env vars explicitly; never inherit host state silently."""
    monkeypatch.setenv(
        "ISSUELENS_DATABASE_URL",
        "postgresql+asyncpg://issuelens:issuelens@localhost:5432/issuelens",
    )
    monkeypatch.setenv("ISSUELENS_REDIS_URL", "redis://127.0.0.1:6379/0")
    get_settings.cache_clear()
    get_engine.cache_clear()
    yield
    if get_engine.cache_info().currsize:
        await get_engine().dispose()
    get_settings.cache_clear()
    get_engine.cache_clear()
