from app.config import get_settings


def test_settings_read_prefixed_env(monkeypatch):
    monkeypatch.setenv("ISSUELENS_DATABASE_URL", "postgresql+asyncpg://u:p@example:5432/db")
    get_settings.cache_clear()
    assert get_settings().database_url == "postgresql+asyncpg://u:p@example:5432/db"


def test_settings_have_defaults():
    s = get_settings()
    assert s.database_url.startswith("postgresql+asyncpg://")
    assert s.redis_url.startswith("redis://")
