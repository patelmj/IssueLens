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
